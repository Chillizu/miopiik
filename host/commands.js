/**
 * 干预入口 —— SPEC §6（用户低成本干预）与 references/user-actions 的「一条逻辑两个调用方」。
 *
 * 同一条 Host 操作（划掉开环 / 标废事实）：
 *  - Mind 走工具（ink_loops close / ink_facts invalidate）
 *  - 用户走界面按钮 → session command `miopiik` → 这里
 * 按钮路径不经模型，也不写对话；结果以 command 事件留在会话日志里。
 */

/** 解析 `/miopiik <domain> <verb> <id>`；纯函数，便于单测。 */
export function parseBackstageCommand(rawInput) {
  const tokens = String(rawInput ?? '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
  if (tokens.length === 0) {
    return { error: '用法：/miopiik loop close L-1 ｜ loop drop L-1 ｜ fact invalidate F-1' }
  }
  const [domain, verb, id] = tokens
  if (domain === 'loop' && (verb === 'close' || verb === 'drop')) {
    if (typeof id !== 'string' || id === '') return { error: '缺少开环 id（例如 L-1）' }
    return { kind: 'loop', op: verb, id }
  }
  if (domain === 'fact' && verb === 'invalidate') {
    if (typeof id !== 'string' || id === '') return { error: '缺少事实卡 id（例如 F-1）' }
    return { kind: 'fact', op: 'invalidate', id }
  }
  return { error: `未知命令：${tokens.join(' ')}` }
}

export function registerBackstageCommand(ctx, engines) {
  const commands = (() => {
    try {
      return ctx.get('commands')
    } catch {
      return undefined
    }
  })()
  if (commands === undefined) return

  ctx.effect(() =>
    commands.register({
      name: 'miopiik',
      description: 'Ink 的后台干预：划掉一条开环（loop close/drop）或标废一张事实卡（fact invalidate）',
      recordInput: false,
      handler: async ({ agent, rawInput }) => {
        const parsed = parseBackstageCommand(rawInput)
        if (parsed.error !== undefined) return { kind: 'error', text: parsed.error }
        const engine = engines.get(String(agent.session.id))
        if (engine === undefined) return { kind: 'error', text: '这个会话还没有 Ink 运行时' }
        try {
          if (parsed.kind === 'loop') {
            if (parsed.op === 'close') {
              await engine.closeLoop(parsed.id, { by: 'user', reason: 'intervention:ui' })
              return { kind: 'success', text: `已划掉 ${parsed.id}` }
            }
            await engine.dropLoop(parsed.id, { by: 'user', reason: 'intervention:ui' })
            return { kind: 'success', text: `已丢弃 ${parsed.id}` }
          }
          await engine.invalidateFact(parsed.id, 'intervention:ui')
          return { kind: 'success', text: `已标废 ${parsed.id}` }
        } catch (error) {
          return { kind: 'error', text: String(error?.message ?? error) }
        }
      },
    }),
  )
}
