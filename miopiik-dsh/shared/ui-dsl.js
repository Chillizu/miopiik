/**
 * 实验原型：面向模型的紧凑声明 DSL（P1 探索，未接入渲染路径）。
 *
 * 目标：验证「比 JSON 更省 token、且模型更好写」的假设，同时不放弃结构校验——
 * 解析产物一律交给 shared/spec-rules.js 的 validateSpec 变成标准 AST，
 * 非法就降级为纯文本，不进渲染。
 *
 * 语法（示例）：
 *   ::card title="本周预算" source="git log"
 *   chart bar
 *   本周 3
 *   下周 5
 *   ::end
 *
 *   ::text title="说明"
 *   p 第一段
 *   b 要点
 *   ::end
 */


const OPEN = /^::([a-z]+)(?:[ \t]+(.*))?$/u
const KV = /([a-z]+)="((?:[^"\\]|\\.)*)"/gu

function readAttrs(text) {
  const attrs = {}
  for (const match of String(text ?? '').matchAll(KV)) attrs[match[1]] = match[2].replace(/\\"/gu, '"')
  return attrs
}

function parseDataset(lines, attrs) {
  const rows = []
  let chart = 'bar'
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('chart ')) {
      chart = trimmed.slice(6).trim()
      continue
    }
    const parts = trimmed.split(/\s+/u)
    if (parts.length < 2) return { error: `无法解析数据行：${trimmed}` }
    const value = Number(parts[parts.length - 1])
    if (!Number.isFinite(value)) return { error: `数值不合法：${trimmed}` }
    rows.push([parts.slice(0, -1).join(' '), value])
  }
  return {
    spec: {
      widget: 'dataset',
      preset: 'card',
      title: attrs.title ?? '',
      props: { chart, columns: [{ label: '项' }, { label: '值' }], rows, ...(attrs.source ? { source: attrs.source } : {}) },
      fallback: attrs.fallback ?? defaultFallback(rows),
    },
  }
}

function parseText(lines, attrs) {
  const paragraphs = []
  const bullets = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('b ')) bullets.push(trimmed.slice(2))
    else if (trimmed.startsWith('p ')) paragraphs.push(trimmed.slice(2))
    else paragraphs.push(trimmed)
  }
  return {
    spec: {
      widget: 'text',
      preset: 'card',
      title: attrs.title ?? '',
      props: { paragraphs, bullets },
      fallback: attrs.fallback ?? defaultFallback([...paragraphs, ...bullets].map((t) => ['', 0])),
    },
  }
}

function defaultFallback(rows) {
  return rows.map((row) => `${row[0]} ${row[1]}`).join('，').slice(0, 300) || '（无内容）'
}

/**
 * 把一段带 DSL 块的正文切成 {kind:'text'|'ui', ...} 片段；非法块降级为 text。
 * @param source 模型输出
 * @param options.measure 为 true 时附带 JSON 对照长度（仅供原型测量）
 */
export function compileInlineDsl(source, validate) {
  const lines = String(source ?? '').split(/\r?\n/u)
  const segments = []
  let buffer = []
  let index = 0
  const flush = () => {
    if (buffer.length > 0) segments.push({ kind: 'text', text: buffer.join('\n') })
    buffer = []
  }
  while (index < lines.length) {
    const open = OPEN.exec(lines[index])
    if (open === null) {
      buffer.push(lines[index])
      index += 1
      continue
    }
    const [, name, rest] = open
    const attrs = readAttrs(rest)
    const body = []
    index += 1
    let closed = false
    while (index < lines.length) {
      if (/^::end\s*$/u.test(lines[index])) {
        closed = true
        index += 1
        break
      }
      body.push(lines[index])
      index += 1
    }
    const parsed = name === 'card' || name === 'chart' ? parseDataset(body, attrs) : name === 'text' ? parseText(body, attrs) : { error: `未知块：${name}` }
    if (!closed || parsed.error !== undefined) {
      buffer.push(...lines.slice(index - body.length - 1, index))
      continue
    }
    const checked = validate(parsed.spec)
    flush()
    if (!checked.ok) {
      segments.push({ kind: 'text', text: attrs.fallback ?? `（这一段界面描述不合法：${checked.errors[0]}）` })
      continue
    }
    segments.push({ kind: 'ui', spec: checked.spec })
  }
  flush()
  return segments
}

/** 原型测量：同一份内容，DSL 与 JSON 各占多少字符（token 成本的粗代理）。 */
export function comparePayloadCost(specs) {
  const json = JSON.stringify(specs)
  const dsl = specs
    .map((spec) => {
      if (spec.widget !== 'dataset') return `::text title="${spec.title ?? ''}"\n::end`
      const rows = spec.props.rows.map((row) => `${row[0]} ${row[1]}`).join('\n')
      return `::card title="${spec.title ?? ''}" source="${spec.props.source ?? ''}"\nchart ${spec.props.chart === true ? 'bar' : spec.props.chart}\n${rows}\n::end`
    })
    .join('\n')
  return { json: json.length, dsl: dsl.length, ratio: Number((dsl.length / json.length).toFixed(2)) }
}
