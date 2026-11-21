/**
 * Operator 派发与守夜 —— SPEC §3.4 / §4.1 / §4.4。
 *
 * 派发走 ctx.subagents（delivery: 'caller'）：结果回到 Ink，不直接回到 Mind 的对话。
 * Ink 负责把结果编译成预览（host/compile.js），再进收件箱。
 * 守夜只在超时/无产出时投递一条 [阻塞] 预览，不替用户做回滚决定。
 */

import { renderContractPrompt, renderDraftPrompt, validateContract, validateDraft } from './contract.js'
import { DEFAULTS, readConfig } from './config-defaults.js'
import { compileResult, fallbackPreview } from './compile.js'
import { openCard, settleCard } from './taskboard.js'

/**
 * 无进展判定（纯函数，便于测试）：任务仍在跑、观测序号没变、且已超过静默阈值。
 * @returns 该不该报「卡住」
 */
export function shouldStall({ job, observedSeq, lastSeen, lastProgressAt, stallMs, now }) {
  if (job === undefined || job?.state !== 'running') return false
  if (observedSeq !== lastSeen) return false
  return now - lastProgressAt >= stallMs
}

/**
 * 解析 Operator 子会话的模型路由（可用于 request.agentOptions）。
 * 支持：
 * - input.model = "opencode-go/glm-5.3"（自动拆 provider/model）
 * - input.provider + input.model
 * - config.operatorModel 为 volatile 引用或普通值：
 *   - 字符串 "provider/model" 或裸模型名（默认 provider: opencode-go）
 *   - 对象 { provider, model }
 */
export function resolveOperatorModel(input, config) {
  if (typeof input?.model === 'string' && input.model.trim() !== '') {
    const raw = input.model.trim()
    const explicitProvider =
      typeof input?.provider === 'string' && input.provider.trim() !== '' ? input.provider.trim() : null
    if (raw.includes('/') && explicitProvider === null) {
      const slash = raw.indexOf('/')
      const provider = raw.slice(0, slash).trim()
      const model = raw.slice(slash + 1).trim()
      if (provider !== '' && model !== '') return { provider, model }
    }
    const provider = explicitProvider ?? config?.operatorModel?.provider ?? 'opencode-go'
    return { provider: String(provider), model: raw }
  }
  // config.operatorModel 走 readConfig：volatile 引用解包成当前值（设置页热生效）。
  const configured = readConfig(config, 'operatorModel')
  if (typeof configured === 'string' && configured.trim() !== '') {
    const raw = configured.trim()
    if (raw.includes('/')) {
      const slash = raw.indexOf('/')
      const provider = raw.slice(0, slash).trim()
      const model = raw.slice(slash + 1).trim()
      if (provider !== '' && model !== '') return { provider, model }
    }
    return { provider: 'opencode-go', model: raw }
  }
  if (configured?.provider && configured?.model) {
    return {
      provider: String(configured.provider),
      model: String(configured.model),
    }
  }
  return null
}

export function assertAllowedOperatorModel({ agentOptions, agent, ctx, services } = {}) {
  if (agentOptions === null || agentOptions === undefined) return

  const parentProvider = agent?.options?.provider
  const parentModel = agent?.options?.model
  if (
    parentProvider !== undefined &&
    parentModel !== undefined &&
    parentProvider === agentOptions.provider &&
    parentModel === agentOptions.model
  ) {
    return
  }

  const selectionService =
    services?.subagentModelSelection ??
    (() => {
      try {
        return ctx?.get?.('subagentModelSelection')
      } catch {
        return undefined
      }
    })()

  if (selectionService === undefined || typeof selectionService?.current !== 'function') {
    return
  }

  const current = selectionService.current()
  const enabled = current?.enabled === true
  const allowedModels = Array.isArray(current?.allowedModels) ? current.allowedModels : []

  if (!enabled) {
    throw new Error(
      `Operator 模型选择未启用（subagent-model-selection-settings.enabled=false），不允许指定 "${agentOptions.provider}/${agentOptions.model}"；省略 model 以跟随当前会话模型。`,
    )
  }

  if (!allowedModels.some((r) => r.provider === agentOptions.provider && r.model === agentOptions.model)) {
    const allowedList = allowedModels.map((r) => `${r.provider}/${r.model}`).join(', ') || '（无）'
    throw new Error(
      `Operator 模型 "${agentOptions.provider}/${agentOptions.model}" 不在 DSH 子智能体模型白名单（allowedModels）中；当前允许：${allowedList}`,
    )
  }
}

export function createOperator({ ctx, engines, config, warn, services = {} }) {
  const running = new Map()
  const childEngines = new Map()
  const childProgress = new Map()
  const hasSessionEventBus = typeof ctx?.on === 'function'

  if (hasSessionEventBus) {
    ctx.on('session/event', (session) => {
      const id = String(session?.id ?? '')
      if (childProgress.has(id)) {
        childProgress.set(id, (childProgress.get(id) ?? 0) + 1)
      }
    })
  }

  const subagents = () => {
    try {
      return ctx.get('subagents')
    } catch {
      return undefined
    }
  }

  const providerName = () => {
    const service = subagents()
    if (service === undefined) return undefined
    if (typeof config?.subagentProvider === 'string') return config.subagentProvider
    try {
      const names = service.list()
      return names.includes('subagent') ? 'subagent' : names[0]
    } catch {
      return undefined
    }
  }

  const start = async ({ agent, engine, input, branchId = null }) => {
    const draft = input?.draft === true
    const check = draft ? validateDraft(input) : validateContract(input)
    if (!check.ok) {
      throw new Error(
        draft
          ? `草稿态至少要有${check.missing.join('、')}`
          : `契约缺要素，只能算草稿：${check.missing.join('、')}。补齐后再派发，或用 draft: true 先跑一版。`,
      )
    }
    const service = subagents()
    if (service === undefined) throw new Error('这个 profile 没有 subagents 服务，无法派发 Operator')
    const provider = providerName()
    if (provider === undefined) throw new Error('没有可用的 subagent provider')

    const agentOptions = resolveOperatorModel(input, config)
    assertAllowedOperatorModel({ agentOptions, agent, ctx, services })
    const jobId = `J-${engine.state.counters.job + 1}`
    const loop = await engine.addLoop({
      text: `O-${jobId}：${input.goal}`,
      type: 'pending-dispatch',
      pointer: jobId,
      closureCondition: '结果被接受，或判废',
    })
    await engine.addJob({
      id: jobId,
      label: input.goal.slice(0, 40),
      contract: {
        goal: input.goal,
        deliverables: input.deliverables,
        acceptance: input.acceptance,
        acceptanceSample: input.acceptanceSample,
        boundary: input.boundary,
        budget: input.budget,
      },
      model: agentOptions ? `${agentOptions.provider}/${agentOptions.model}` : null,
      loopId: loop.id,
      branchId,
      childId: null,
      state: 'running',
      startedAt: Date.now(),
      endedAt: null,
      stopReason: null,
    })

    // 分支上下文切片：Operator 拿到的不是整个对话，是这一段工作需要的前提。
    let branchSlice = null
    if (branchId !== null && typeof engine.branchSlice === 'function') {
      try {
        branchSlice = engine.branchSlice(branchId).text
      } catch {
        branchSlice = null
      }
    }

    const controller = new AbortController()
    let activation
    try {
      activation = await service.startActivation({
        provider,
        label: `O-${jobId} ${input.goal.slice(0, 24)}`,
        request: {
          parent: agent,
          ...(agentOptions !== null ? { agentOptions } : {}),
          prompt: [{ type: 'text', text: draft ? renderDraftPrompt(input) : renderContractPrompt(input, branchSlice) }],
        },
        signal: controller.signal,
        delivery: 'caller',
      })
    } catch (error) {
      await engine.updateJob(jobId, { state: 'failed', endedAt: Date.now(), stopReason: 'start-failed' })
      throw error
    }

    await engine.updateJob(jobId, { childId: String(activation.childId) })
    if (branchId !== null) await engine.attachJobToBranch(branchId, jobId)
    childEngines.set(String(activation.childId), engine)
    childProgress.set(String(activation.childId), 0)

    // 无进展守夜（SPEC §3.4）：不是「跑太久」，而是「跑着但没动静」。
    // 判据是子会话观测计数有没有新事件（工具结果、回合边界、ink_ask/ink_report 都算），不受父会话闲聊干扰。
    const readObservedSeq = () =>
      hasSessionEventBus ? (childProgress.get(String(activation.childId)) ?? 0) : engine.state.counters.obs
    const stallMs = Number(readConfig(config, 'operatorStallMs') ?? DEFAULTS.operatorStallMs)
    const stallPollMs =
      stallMs < 30_000 ? Math.max(10, Math.floor(stallMs / 3)) : Math.max(30_000, Math.floor(stallMs / 3))
    let lastSeen = readObservedSeq()
    let lastProgressAt = Date.now()
    let stalled = false
    const stallTimer = setInterval(async () => {
      try {
        const now = readObservedSeq()
        const job = engine.state.jobs.get(jobId)
        if (job === undefined || job.state !== 'running') return
        if (now !== lastSeen) {
          lastSeen = now
          lastProgressAt = Date.now()
          return
        }
        const decision = shouldStall({
          job,
          observedSeq: now,
          lastSeen,
          lastProgressAt,
          stallMs,
          now: Date.now(),
        })
        if (!decision || stalled) return
        stalled = true
        await engine.updateJob(jobId, { state: 'stalled', stalledAt: Date.now() })
        const synthetic = { id: jobId, loopId: loop.id, branchId, label: input.goal.slice(0, 40) }
        await engine.deliverNote(
          fallbackPreview(
            synthetic,
            `O-${jobId} 看起来卡住了：${Math.round(stallMs / 60000)} 分钟没有新动静`,
            '要不要停掉它，或者让它换个做法？',
            `最后一次观测在 job ${jobId}；预算：${input.budget}`,
          ),
          { blocking: true },
        )
      } catch (error) {
        warn(`无进展守夜失败：${error?.message ?? error}`)
      }
    }, stallPollMs)
    if (typeof stallTimer.unref === 'function') stallTimer.unref()

    // 每次派发都按当前值读：设置页改完 operatorTimeoutMs 后，新任务即按新阈值守夜。
    const timeoutMs = Number(readConfig(config, 'operatorTimeoutMs') ?? DEFAULTS.operatorTimeoutMs)
    const timer = setTimeout(() => {
      clearInterval(stallTimer)
      // 超时守夜：只投递 [阻塞] 预览，不替 Mind/用户做回滚决定（SPEC §3.4）。
      engine.updateJob(jobId, { state: 'timeout' }).catch(() => undefined)
      const synthetic = { id: jobId, loopId: loop.id, branchId, label: input.goal.slice(0, 40) }
      engine
        .deliverNote(fallbackPreview(synthetic, `O-${jobId} 超时未回（预算：${input.budget}）`, '要不要停掉它？'), {
          blocking: true,
        })
        .catch((error) => warn(`守夜投递失败：${error?.message ?? error}`))
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    running.set(jobId, { activation, timer, stallTimer, engine, agent })

    // 任务板归中间层（Ink）——这里只是把契约交给它开卡。
    const teamTask = await (async () => {
      try {
        return await openCard(ctx, agent, { jobId, contract: input })
      } catch (error) {
        warn(`任务板开卡失败（不影响派发）：${String(error?.message ?? error).slice(0, 120)}`)
        return null
      }
    })()
    if (teamTask !== null) await engine.updateJob(jobId, { teamTaskId: teamTask.id })

    activation.result
      .then(async (result) => {
        clearTimeout(timer)
        clearInterval(stallTimer)
        running.delete(jobId)
        childEngines.delete(String(activation.childId))
        childProgress.delete(String(activation.childId))
        const text = (result?.output ?? [])
          .filter((block) => block?.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n')
          .trim()
        await engine.updateJob(jobId, {
          state: result?.stopReason === 'completed' ? 'done' : 'failed',
          endedAt: Date.now(),
          stopReason: result?.stopReason ?? null,
        })
        await settleCard(ctx, agent, teamTask, result?.stopReason === 'completed' ? '完成' : `未完成（${result?.stopReason ?? 'unknown'}）`)
        if (draft) {
          // 草稿态：结果留在草稿区，不打扰用户、不进收件箱（SPEC §4.4）。
          await engine.addDraft({
            title: input.goal.slice(0, 60),
            summary: text.slice(0, 400),
            artifact: `job:${jobId}`,
            conf: 'low',
            source: 'operator',
          })
          await engine.closeLoop(loop.id, { reason: 'draft:settled', by: 'ink' })
          return
        }
        const job = { id: jobId, loopId: loop.id, branchId, label: input.goal.slice(0, 40) }
        const note = await compileResult({ ctx, engine, job, resultText: text, config, warn })
        await engine.deliverNote(note)
      })
      .catch(async (error) => {
        clearTimeout(timer)
        clearInterval(stallTimer)
        running.delete(jobId)
        childEngines.delete(String(activation.childId))
        childProgress.delete(String(activation.childId))
        try {
          await engine.updateJob(jobId, { state: 'failed', endedAt: Date.now(), stopReason: 'settle-threw' })
          const job = { id: jobId, loopId: loop.id, branchId, label: input.goal.slice(0, 40) }
          await engine.deliverNote(
            fallbackPreview(job, `O-${jobId} 失败：${String(error?.message ?? error).slice(0, 80)}`, '要不要重试？'),
            { blocking: true },
          )
        } catch (inner) {
          warn(`派发失败收尾异常：${inner?.message ?? inner}`)
        }
      })

    return { jobId, loopId: loop.id, childId: String(activation.childId), provider }
  }

  const list = () => [...running.keys()]
  const engineForChild = (sessionId) => {
    const id = String(sessionId)
    if (childProgress.has(id)) {
      childProgress.set(id, (childProgress.get(id) ?? 0) + 1)
    }
    return childEngines.get(id)
  }

  return { start, list, engineForChild }
}
