/** 离线分析 tools/bench-formats.mjs 产生的会话：格式合法率、降级数、输出 token、可见字符。 */
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseMiopiikMl } from '../miopiik-iui/shared/miopiik-ml.js'
import { validateAst } from '../miopiik-iui/shared/iui-ast.js'

const ROOT = '/home/chillizu/.dsh/sessions/--home-data-Projects-Mio-MiOpIIk--/'
const dirs = readdirSync(ROOT)
  .filter((n) => n.startsWith('session-'))
  .map((n) => ({ n, m: statSync(join(ROOT, n, 'session.v4.jsonl.zstd')).mtimeMs }))
  .sort((a, b) => b.m - a.m)
  .slice(0, 14)

const rows = []
for (const { n } of dirs) {
  let raw = ''
  try {
    raw = execFileSync('zstd', ['-dc', join(ROOT, n, 'session.v4.jsonl.zstd')], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  } catch {
    continue
  }
  let format = null
  let text = ''
  let outputTokens = 0
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.type === 'user/message' && format === null) {
      const t = (e.data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
      if (t.includes('纯文本生成测试')) format = t.includes('不是 HTML') ? 'ml' : 'json'
    }
    if (e.type === 'assistant/message') {
      outputTokens += e.data.usage?.outputTokens ?? 0
      for (const b of e.data.message?.content ?? []) if (b.type === 'text') text += b.text
    }
  }
  if (format === null || text === '') continue
  const fence = /```[a-z-]*\s*\n([\s\S]*?)```/u.exec(text)
  const body = fence ? fence[1] : text
  let ok = false
  let degraded = 0
  let switchable = false
  let visible = body.length
  if (format === 'ml') {
    const parsed = parseMiopiikMl(body)
    if (parsed.ok) {
      const checked = validateAst(parsed.doc)
      ok = checked.ok
      degraded = (checked.ok ? checked.degraded : 0) + parsed.degraded.length
      switchable = JSON.stringify(parsed.doc).includes('"type":"segmented"')
    }
  } else {
    try {
      const parsed = JSON.parse(body)
      const checked = validateAst(parsed)
      ok = checked.ok
      degraded = checked.ok ? checked.degraded : 0
      switchable = JSON.stringify(parsed).includes('"segmented"')
    } catch {
      ok = false
    }
  }
  rows.push({ format, ok, degraded, switchable, outputTokens, visibleChars: visible, session: n.slice(0, 16) })
}
const byFormat = {}
for (const row of rows) (byFormat[row.format] ??= []).push(row)
console.log(JSON.stringify({ rows, summary: Object.fromEntries(Object.entries(byFormat).map(([k, list]) => [k, {
  samples: list.length,
  valid: list.filter((r) => r.ok).length,
  switchable: list.filter((r) => r.switchable).length,
  meanOutputTokens: Math.round(list.reduce((a, r) => a + r.outputTokens, 0) / list.length),
  meanVisibleChars: Math.round(list.reduce((a, r) => a + r.visibleChars, 0) / list.length),
  meanDegraded: Number((list.reduce((a, r) => a + r.degraded, 0) / list.length).toFixed(1)),
}])) }, null, 2))
