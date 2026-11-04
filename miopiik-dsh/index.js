/**
 * miopiik-dsh — MiOpIIk（Mind · Ink · Operator）的 DSH host 半边。
 *
 * Batch 2：Ink 的确定性核心。
 *  - 观测日志：把会话事件机械筛成 append-only 记录（用户真人提示 + 助手最终消息 + 回合边界 + 折叠）；
 *  - 账本：note / 事实卡 / 开环 / 收件箱 / 草稿 / 简报的落盘与回放（JSONL，见 host/store.js 顶部说明）；
 *  - 老化与投递：按天轴把开环推进到休眠，休眠时投递一条带指针的预览；
 *  - L3：每轮装配时把活跃开环 + 收件箱待读放进 Mind 的上下文（prompt context，不进聊天记录）；
 *  - 窄工具面：ink_status / ink_loops / ink_facts / ink_inbox。
 *
 * 不变式：本文件没有任何向对话写内容的路径；Ink 不叙事、不回复用户。
 * 子 agent（将来的 Operator）会在 agent/created 时被 restrict 掉这组工具。
 */

import { join } from 'node:path'

import { Engine, INK_TOOL_NAMES } from './host/engine.js'
import { openStore } from './host/store.js'
import { registerPrompt } from './host/prompt.js'
import { createOperator } from './host/operator.js'
import { registerBackstageCommand } from './host/commands.js'
import { registerTools } from './host/tools.js'

/** Host 依赖：工具注册是必须的；其余通过 ctx.get 取，缺了也不让插件装不上。 */
export const inject = ['tools']

export function apply(ctx, config) {
  const stateRoot = String(config?.stateRoot ?? '.dsh/miopiik')
  const engines = new Map()

  const warn = (message) => {
    try {
      ctx.logger?.('miopiik-dsh')?.warn?.(message)
    } catch {
      // 日志不可用时不制造二次故障。
    }
  }

  const cwdOf = (session) => {
    try {
      const dir = ctx.get('workingDirectory')?.get?.(session)
      if (typeof dir === 'string' && dir !== '') return dir
    } catch {
      // 落到 header.cwd。
    }
    return session?.header?.cwd ?? process.cwd()
  }

  const isRootSession = (agent) => {
    try {
      const roots = ctx.get('agents')?.roots?.() ?? []
      if (roots.length === 0) return true
      return roots.some((root) => String(root?.session?.id) === String(agent.session.id))
    } catch {
      return true
    }
  }

  const initializing = new Set()

  const initAgent = async (agent) => {
    const sessionId = String(agent.session.id)
    try {
      if (!isRootSession(agent)) {
        // Operator 子 agent 拿不到 Ink 的工具面：不是靠提示词，是靠结构。
        try {
          agent.ctx?.tools?.restrict?.({ deny: [...INK_TOOL_NAMES] })
        } catch {
          // 子 agent 没有独立工具的旧版本可以忽略。
        }
        return
      }
      if (engines.has(sessionId) || initializing.has(sessionId)) return
      initializing.add(sessionId)
      try {
        const store = await openStore(join(cwdOf(agent.session), stateRoot), sessionId)
        engines.set(sessionId, new Engine({ store, sessionId }))
      } finally {
        initializing.delete(sessionId)
      }
    } catch (error) {
      warn(`无法为会话 ${sessionId} 打开 Ink 账本：${error?.message ?? error}`)
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    void initAgent(agent)
  })

  // 插件热重载（profile bundle 开关）后，已存在的 agent 不会重新触发 agent/created。
  // 启动时扫一次存量，再延迟兜底一次，避免运行中的会话没有 Ink 运行时。
  const sweep = () => {
    try {
      for (const agent of ctx.get('agents')?.list?.() ?? []) void initAgent(agent)
    } catch {
      // 服务未就绪时交给 agent/created。
    }
  }
  sweep()
  const sweepTimer = setTimeout(sweep, 2000)
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()

  ctx.on('agent/disposed', ({ agent }) => {
    try {
      engines.delete(String(agent.session.id))
    } catch {
      // 忽略。
    }
  })

  ctx.on('session/event', (session, event) => {
    const engine = engines.get(String(session.id))
    if (engine !== undefined) engine.observe(event)
  })

  // 客户端数据面：session projection（Host 计算，wire 到浏览器；不经过模型）
  const registerProjection = () => {
    const projections = (() => {
      try {
        return ctx.get('sessionProjections')
      } catch {
        return undefined
      }
    })()
    if (projections === undefined) return
    ctx.effect(() =>
      projections.register({
        key: 'miopiikBackstage',
        stateVersion: 1,
        stateSchema: { parse: (value) => value },
        init: (header) => ({ sessionId: String(header?.id ?? header?.sessionId ?? ''), rev: 0 }),
        apply: (state, event) => {
          const type = event?.type
          if (
            type === 'turn/end' ||
            type === 'tool/result' ||
            type === 'command/done' ||
            type === 'agent/inbox/spliced'
          ) {
            return { ...state, rev: state.rev + 1 }
          }
          return state
        },
        wire: {
          viewSchema: { parse: (value) => value },
          view: (state) => {
            const engine = engines.get(String(state.sessionId))
            const snapshot = engine?.backstageSnapshot?.()
            return snapshot === undefined ? { empty: true } : snapshot
          },
        },
      }),
    )
  }
  registerProjection()
  registerBackstageCommand(ctx, engines)

  const operator = createOperator({ ctx, engines, config, warn })
  registerTools(ctx, engines, operator)
  registerPrompt(ctx, engines)
}
