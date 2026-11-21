/**
 * 干预入口 —— SPEC §6（用户低成本干预）与 references/user-actions 的「一条逻辑两个调用方」。
 *
 * 同一条 Host 操作（划掉开环 / 标废事实）：
 *  - Mind 走工具（ink_loops close / ink_facts invalidate）
 *  - 用户走界面按钮 → session command `miopiik` → 这里
 * 按钮路径不经模型，也不写对话；结果以 command 事件留在会话日志里。
 *
 * `audit` 子命令是全量流水的取数通道：浏览器端 client.js 已证明
 * `remote.commands.execute(sessionId, line, [])` 可达（client.js 干预按钮走的就是它），
 * host 在这里把 auditPage 的结果装进 command result 的 text（JSON）带回浏览器。
 * 代价由 DSH 结构决定：每次 execute 落 command/run + command/done 两条 log-only 事件
 * （recordInput:false 不记参数；返回文本会随 command/done 留痕，limit 上限由 audit.js 封顶）。
 */

/** 解析 `/miopiik audit [page] key=value…`；纯函数，便于单测。 */
const AUDIT_NUMBER_KEYS = Object.freeze(['day', 'before', 'beforeSeq', 'limit'])
const AUDIT_STRING_KEYS = Object.freeze(['kind', 'branch'])
const AUDIT_KEYS = Object.freeze([...AUDIT_NUMBER_KEYS, ...AUDIT_STRING_KEYS])

function parseAuditCommand(rest) {
  if (rest.length > 0 && rest[0] === 'page') rest = rest.slice(1)
  const query = {}
  for (const token of rest) {
    const eq = token.indexOf('=')
    if (eq <= 0) return { error: `audit 参数要写成 key=value，例如 audit day=20778 limit=50（可用：${AUDIT_KEYS.join('/')}）` }
    const key = token.slice(0, eq)
    const value = token.slice(eq + 1)
    if (!AUDIT_KEYS.includes(key)) return { error: `未知 audit 参数: ${key}（可用：${AUDIT_KEYS.join('/')}）` }
    if (AUDIT_NUMBER_KEYS.includes(key)) {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) return { error: `${key} 要是数字，收到 ${value}` }
      query[key] = parsed
    } else {
      query[key] = value
    }
  }
  return { kind: 'audit', query }
}

/** 解析 `/miopiik <domain> <verb> <id>`；纯函数，便于单测。 */
export function parseBackstageCommand(rawInput) {
  const tokens = String(rawInput ?? '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
  if (tokens.length === 0) {
    return { error: '用法：/miopiik loop close L-1 ｜ loop drop L-1 ｜ fact invalidate F-1 ｜ audit [day=… limit=50 kind=… branch=…]' }
  }
  const [domain, verb, id] = tokens
  if (domain === 'audit') return parseAuditCommand(tokens.slice(1))
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
      description: 'Ink 的后台干预：划掉一条开环（loop close/drop）、标废一张事实卡（fact invalidate），或翻全量流水（audit）',
      recordInput: false,
      handler: async ({ agent, rawInput }) => {
        const parsed = parseBackstageCommand(rawInput)
        if (parsed.error !== undefined) return { kind: 'error', text: parsed.error }
        const engine = engines.get(String(agent.session.id))
        if (engine === undefined) return { kind: 'error', text: '这个会话还没有 Ink 运行时' }
        try {
          if (parsed.kind === 'audit') {
            // 取数通道：结果装进 command result text，客户端 JSON.parse 即得 { rows, nextCursor }。
            const page = engine.auditPage(parsed.query)
            return { kind: 'success', text: JSON.stringify(page) }
          }
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
