/**
 * Operator 派发与守夜 —— SPEC §3.4 / §4.1 / §4.4。
 *
 * 派发走 ctx.subagents（delivery: 'caller'）：结果回到 Ink，不直接回到 Mind 的对话。
 * Ink 负责把结果编译成预览（host/compile.js），再进收件箱。
 * 守夜只在超时/无产出时投递一条 [阻塞] 预览，不替用户做回滚决定。
 */

import { renderContractPrompt, validateContract } from './contract.js'
import { compileResult, fallbackPreview } from './compile.js'

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

  const start = async ({ agent, engine, input }) => {
    const { ok, missing } = validateContract(input)
    if (!ok) {
      throw new Error(`契约缺要素，只能算草稿：${missing.join('、')}。补齐后再派发。`)
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
      childId: null,
      state: 'running',
      startedAt: Date.now(),
      endedAt: null,
      stopReason: null,
    })

    const controller = new AbortController()
    let activation
    try {
      activation = await service.startActivation({
        provider,
        label: `O-${jobId} ${input.goal.slice(0, 24)}`,
        request: {
          parent: agent,
          prompt: [{ type: 'text', text: renderContractPrompt(input) }],
        },
        signal: controller.signal,
        delivery: 'caller',
      })
    } catch (error) {
      await engine.updateJob(jobId, { state: 'failed', endedAt: Date.now(), stopReason: 'start-failed' })
      throw error
    }

    await engine.updateJob(jobId, { childId: String(activation.childId) })
    childEngines.set(String(activation.childId), engine)

    const timeoutMs = Number(config?.operatorTimeoutMs ?? 20 * 60 * 1000)
    const timer = setTimeout(() => {
      // 守夜：超时只投递 [阻塞] 预览，不替 Mind/用户做回滚决定（SPEC §3.4）。
      engine.updateJob(jobId, { state: 'timeout' }).catch(() => undefined)
      const synthetic = { id: jobId, loopId: loop.id, label: input.goal.slice(0, 40) }
      engine
        .deliverNote(fallbackPreview(synthetic, `O-${jobId} 超时未回（预算：${input.budget}）`, '要不要停掉它？'), {
          blocking: true,
        })
        .catch((error) => warn(`守夜投递失败：${error?.message ?? error}`))
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    running.set(jobId, { activation, timer, engine, agent })

    activation.result
      .then(async (result) => {
        clearTimeout(timer)
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
        const job = { id: jobId, loopId: loop.id, label: input.goal.slice(0, 40) }
        const note = await compileResult({ ctx, engine, job, resultText: text, config, warn })
        await engine.deliverNote(note)
      })
      .catch(async (error) => {
        clearTimeout(timer)
        running.delete(jobId)
        childEngines.delete(String(activation.childId))
        try {
          await engine.updateJob(jobId, { state: 'failed', endedAt: Date.now(), stopReason: 'settle-threw' })
          const job = { id: jobId, loopId: loop.id, label: input.goal.slice(0, 40) }
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
