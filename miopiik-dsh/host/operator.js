/**
 * Operator 派发与守夜 —— SPEC §3.4 / §4.1 / §4.4。
 *
 * 派发走 ctx.subagents（delivery: 'caller'）：结果回到 Ink，不直接回到 Mind 的对话。
 * Ink 负责把结果编译成预览（host/compile.js），再进收件箱。
 * 守夜只在超时/无产出时投递一条 [阻塞] 预览，不替用户做回滚决定。
 */

import { renderContractPrompt, renderDraftPrompt, validateContract, validateDraft } from './contract.js'
import { DEFAULTS } from './config-defaults.js'
import { compileResult, fallbackPreview } from './compile.js'

/**
 * 无进展判定（纯函数，便于测试）：任务仍在跑、观测序号没变、且已超过静默阈值。
 * @returns 该不该报「卡住」
 */
export function shouldStall({ job, observedSeq, lastSeen, lastProgressAt, stallMs, now }) {
  if (job === undefined || job?.state !== 'running') return false
  if (observedSeq !== lastSeen) return false
  return now - lastProgressAt >= stallMs
}

export function createOperator({ ctx, engines, config, warn }) {
  const running = new Map()
  const childEngines = new Map()

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

    // 共享任务板：派发即开卡，团队视图里能看到「O 在做什么」。
    // 没有会籍（普通会话不是 Lead）时静默跳过——这是可选接线，不是依赖。
    let teamTask = null
    try {
      const teams = ctx.get('agentTeams')
      if (teams !== undefined && teams.tryMembership?.(agent) !== undefined) {
        teamTask = await teams.createTask(agent, {
          subject: `O-${jobId} ${input.goal}`.slice(0, 80),
          description: [
            input.goal,
            input.deliverables ? `交付：${input.deliverables}` : null,
            input.acceptance ? `验收：${input.acceptance}` : null,
            input.boundary ? `边界：${input.boundary}` : null,
            input.budget ? `预算：${input.budget}` : null,
          ].filter(Boolean).join('\n'),
        })
        await engine.updateJob(jobId, { teamTaskId: teamTask.id })
      }
    } catch {
      teamTask = null
    }

    /** 任务收尾时把共享任务卡一并推进。 */
    const settleTeamTask = async (state) => {
      if (teamTask === null) return
      try {
        const teams = ctx.get('agentTeams')
        // 一次调用同时改描述与状态：分开两次会因为版本号前进而失配（踩过）。
        const current = teams.getTask(agent, teamTask.id)
        await teams.updateTask(agent, {
          taskId: teamTask.id,
          expectedRevision: current.revision,
          action: 'complete',
          description: `${current.description ?? ''}\n\n结果：${state}`,
        })
      } catch {
        // 共享任务板只是可见性，不因为它的失败影响任务本身
      }
    }
    if (branchId !== null) await engine.attachJobToBranch(branchId, jobId)
    childEngines.set(String(activation.childId), engine)

    // 无进展守夜（SPEC §3.4）：不是「跑太久」，而是「跑着但没动静」。
    // 判据是观测日志里有没有新事件（工具结果、回合边界都算），不是猜它在想什么。
    const stallMs = Number(config?.operatorStallMs ?? DEFAULTS.operatorStallMs)
    let lastSeen = engine.state.counters.obs
    let lastProgressAt = Date.now()
    let stalled = false
    const stallTimer = setInterval(async () => {
      try {
        const now = engine.state.counters.obs
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
    }, Math.max(30_000, Math.floor(stallMs / 3)))
    if (typeof stallTimer.unref === 'function') stallTimer.unref()

    const timeoutMs = Number(config?.operatorTimeoutMs ?? DEFAULTS.operatorTimeoutMs)
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

    activation.result
      .then(async (result) => {
        clearTimeout(timer)
        clearInterval(stallTimer)
        running.delete(jobId)
        childEngines.delete(String(activation.childId))
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
        await settleTeamTask(result?.stopReason === 'completed' ? '完成' : `未完成（${result?.stopReason ?? 'unknown'}）`)
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
  const engineForChild = (sessionId) => childEngines.get(String(sessionId))

  return { start, list, engineForChild }
}
