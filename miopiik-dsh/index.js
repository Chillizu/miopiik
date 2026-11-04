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

  ctx.on('agent/created', async ({ agent }) => {
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
      if (engines.has(sessionId)) return
      const store = await openStore(join(cwdOf(agent.session), stateRoot), sessionId)
      engines.set(sessionId, new Engine({ store, sessionId }))
    } catch (error) {
      warn(`无法为会话 ${sessionId} 打开 Ink 账本：${error?.message ?? error}`)
    }
  })

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

  registerTools(ctx, engines)
  registerPrompt(ctx, engines)
}
