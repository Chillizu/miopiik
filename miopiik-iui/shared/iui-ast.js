/**
 * IUI AST v1（实验层）：有限的受信组件 + 任意组合 + 局部状态绑定。
 *
 * 设计边界：
 *  - 模型/示例只产出**结构**（组件树 + 属性 + 状态初值 + 声明式绑定），不产出 CSS/JS；
 *  - 组件类型必须在 REGISTRY 白名单内，未知类型→所在子树降级为 fallback 文本；
 *  - 绑定只允许 `$state.<key>` 与 `$data.<key>` 两种形式，不做表达式求值；
 *  - 预算（节点数/深度/数据量）在这里统一拒绝，由调用方决定降级策略。
 */

export const IUI_VERSION = 'iui/1'

export const REGISTRY = Object.freeze({
  text: { props: { text: 'string' }, children: false },
  metric: { props: { label: 'string', value: 'value', unit: 'string?', note: 'string?', delta: 'string?', caption: 'string?', tone: 'string?' }, children: false },
  row: { props: { gap: 'number?' }, children: true },
  column: { props: { gap: 'number?' }, children: true },
  card: { props: { title: 'string?', subtitle: 'string?', gap: 'number?', span: 'number?', align: 'string?' }, children: true },
  grid: { props: { columns: 'number?', gap: 'number?', align: 'string?' }, children: true },
  table: { props: { columns: 'value', rows: 'value', caption: 'string?' }, children: false },
  // 行内原语：与文字同处一行，顺序即 AST 顺序（不是另开卡片）
  paragraph: { props: { gap: 'number?' }, children: true },
  badge: { props: { text: 'string', tone: 'string?' }, children: false },
  icon: { props: { name: 'string', label: 'string?' }, children: false },
  emphasis: { props: { text: 'string', strong: 'boolean?' }, children: false },
  code: { props: { text: 'string' }, children: false },
  link: { props: { text: 'string', href: 'string' }, children: false },
  // 块级反馈原语
  callout: { props: { tone: 'string?', title: 'string?', text: 'string?' }, children: true },
  progress: { props: { label: 'string?', value: 'number', max: 'number?', tone: 'string?' }, children: false },
  empty: { props: { text: 'string?', title: 'string?', description: 'string?', icon: 'string?' }, children: false },
  chart: { props: { kind: 'string', series: 'value', source: 'string?' }, children: false },
  segmented: { props: { label: 'string?', options: 'value', bind: 'string' }, children: false },
  divider: { props: { label: 'string?' }, children: false },
})

export const LIMITS = Object.freeze({ nodes: 120, depth: 6, series: 60, options: 6, text: 2000, stateBytes: 16384 })

/** 行内原语：paragraph 只接受这些子节点，保证"同一行文字混排"的语义。 */
export const INLINE_TYPES = Object.freeze(['text', 'badge', 'icon', 'emphasis', 'code', 'link'])
export const TONES = Object.freeze(['neutral', 'success', 'warning', 'danger', 'info', 'accent'])
export const ICONS = Object.freeze(['check', 'alert', 'dot', 'arrow-right', 'spark', 'chart', 'layers', 'shield', 'clock', 'inbox', 'info'])

const BIND = /^\$(state|data)\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)$/u
const RESERVED = new Set(['__proto__', 'prototype', 'constructor'])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 只允许 `$state.x` / `$data.x`，其余原样返回。 */
export function readBinding(value) {
  if (typeof value !== 'string') return { literal: value }
  const match = BIND.exec(value)
  return match === null || match[2].split('.').some((part) => RESERVED.has(part)) ? { literal: value } : { scope: match[1], key: match[2] }
}

/** 解析绑定到实际值（无表达式、无函数）。 */
export function resolveValue(value, scope) {
  const binding = readBinding(value)
  if (binding.scope === undefined) return binding.literal
  // 只按点号取属性，不求值、不调用函数
  let cursor = scope[binding.scope]
  for (const part of binding.key.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = cursor[part]
  }
  return cursor
}

/**
 * 把受信图表输入统一变成 [标签, 数值] 点列。
 * 模型常给数字数组、[label,value] 数组或 {label,value}；三种都受限解析，不用表达式。
 */
export function chartMatrix(series) {
  if (!Array.isArray(series) || series.length === 0 || series.length > LIMITS.series) return null
  const rows = []
  for (let i = 0; i < series.length; i += 1) {
    const item = series[i]
    let label = String(i + 1)
    let raw
    if (typeof item === 'number') raw = item
    else if (Array.isArray(item) && item.length >= 2) {
      label = String(item[0])
      raw = item[1]
    } else if (isRecord(item)) {
      label = String(item.label ?? i + 1)
      raw = item.value
    } else return null
    const value = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '')
      ? Number(raw)
      : NaN
    if (!Number.isFinite(value) || label.length > 100) return null
    rows.push([label, value])
  }
  return rows
}

/** 本地状态也是来自模型的 JSON；避免超大对象和原型属性污染。 */
function stateSafe(value, depth = 0) {
  if (depth > 8) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return value.length <= LIMITS.text
  if (Array.isArray(value)) return value.length <= 128 && value.every((item) => stateSafe(item, depth + 1))
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  return keys.length <= 64 && keys.every((key) => key.length <= 64 && !RESERVED.has(key) && stateSafe(value[key], depth + 1))
}

/**
 * 校验并规范化一棵 AST（**局部容错**）。
 *
 * 规则：
 *  - 根节点不合法 / 深度或节点预算超限 → 整份拒绝（安全边界，不尝试修复）；
 *  - 子节点不合法 → 只把该子树替换成 fallback 文本节点，兄弟与父布局保留；
 *  - 未知组件、props 不合法、subtree 预算越界都走同一条降级路径。
 *
 * @returns {{ok:true, ast, errors:string[], degraded:number} | {ok:false, errors:string[], fallback:string}}
 */
export function validateAst(input) {
  const fatal = []
  let nodes = 0
  let degraded = 0

  const failNode = (node, path, reason) => {
    degraded += 1
    const text = typeof node?.fallback === 'string' && node.fallback.trim() !== '' ? node.fallback : `（此段组件无法渲染：${reason}）`
    return { id: `${path}-degraded`, type: 'text', props: { text }, children: [], degraded: true }
  }

  const walk = (node, depth, path) => {
    if (!isRecord(node)) return failNode(node, path, '不是对象')
    if (depth > LIMITS.depth) {
      fatal.push(`${path} 超过最大深度 ${LIMITS.depth}`)
      return null
    }
    nodes += 1
    if (nodes > LIMITS.nodes) {
      fatal.push(`节点数超过 ${LIMITS.nodes}`)
      return null
    }
    const spec = REGISTRY[node.type]
    if (spec === undefined) return failNode(node, path, `未知组件类型 ${String(node.type)}`)
    const props = isRecord(node.props) ? node.props : {}
    if (props.bind !== undefined && readBinding(props.bind).scope !== 'state') {
      return failNode(node, path, 'bind 只能绑定 $state.*')
    }
    if (node.type === 'segmented' && (!Array.isArray(props.options) || props.options.length === 0 || props.options.length > LIMITS.options)) {
      return failNode(node, path, `options 需要 1–${LIMITS.options} 项`)
    }
    if (node.type === 'chart') {
      if (!['bar', 'line'].includes(props.kind ?? 'bar')) return failNode(node, path, 'chart.kind 只能为 bar/line')
      const binding = readBinding(props.series)
      if (binding.scope === undefined && chartMatrix(binding.literal) === null) return failNode(node, path, 'chart.series 需要有效点列或状态绑定')
    }
    if (node.type === 'text' && typeof props.text === 'string' && props.text.length > LIMITS.text) {
      return failNode(node, path, `text 超过 ${LIMITS.text} 字`)
    }
    if (node.type === 'table') {
      if (!Array.isArray(props.columns) || props.columns.length === 0 || props.columns.length > 12) return failNode(node, path, 'table 需要 1–12 列')
      if (!Array.isArray(props.rows)) return failNode(node, path, 'table 需要 rows 数组')
      if (props.rows.length > 200) return failNode(node, path, 'table 最多 200 行')
      const columnsOk = props.columns.every((column) => typeof column === 'string' || (isRecord(column) && typeof column.label === 'string' && (column.key === undefined || (typeof column.key === 'string' && !RESERVED.has(column.key) && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(column.key)))))
      if (!columnsOk) return failNode(node, path, 'table.columns 需要字符串或 {key,label} 描述符')
      const rowsOk = props.rows.every((row) => Array.isArray(row) || (row !== null && typeof row === 'object'))
      if (!rowsOk) return failNode(node, path, 'table.rows 的每一项需要数组或对象')
      if (JSON.stringify(props).length > LIMITS.stateBytes) return failNode(node, path, 'table 数据超出容量预算')
    }
    if (node.type === 'paragraph') {
      const inlineKids = Array.isArray(node.children) ? node.children : []
      const bad = inlineKids.find((child) => child === null || typeof child !== 'object' || !INLINE_TYPES.includes(child.type))
      if (bad !== undefined) return failNode(node, path, `paragraph 只接受行内组件（${INLINE_TYPES.join('/')}）`)
    }
    if (node.type === 'badge' && props.tone !== undefined && !TONES.includes(props.tone)) {
      return failNode(node, path, `badge.tone 只能是 ${TONES.join('/')}`)
    }
    if (node.type === 'callout' && props.tone !== undefined && !TONES.includes(props.tone)) {
      return failNode(node, path, `callout.tone 只能是 ${TONES.join('/')}`)
    }
    for (const type of ['metric', 'progress']) {
      if (node.type === type && props.tone !== undefined && !TONES.includes(props.tone)) {
        return failNode(node, path, `${type}.tone 只能是 ${TONES.join('/')}`)
      }
    }
    if (node.type === 'icon' && !ICONS.includes(props.name)) {
      // 未知图标名不整节点丢弃：降级为 dot，保留语义可选性（图标只是装饰）
      props.name = 'dot'
    }
    if (node.type === 'link') {
      const href = typeof props.href === 'string' ? props.href : ''
      // 只接受 https 绝对地址或站内相对路径（以 / 开头）；javascript:/data: 等一律拒绝
      if (!/^(https:\/\/[^\s]+|\/(?!\/)[^\s]*|#[A-Za-z][A-Za-z0-9_-]*)$/u.test(href)) return failNode(node, path, 'link 只接受 https、站内路径或安全锚点')
    }
    if (node.type === 'progress') {
      if (typeof props.value !== 'number' || !Number.isFinite(props.value) || props.value < 0) {
        return failNode(node, path, 'progress.value 需要 >= 0 的数字')
      }
      if (props.max !== undefined && (typeof props.max !== 'number' || props.max <= 0)) {
        return failNode(node, path, 'progress.max 需要正数')
      }
    }
    if (node.type === 'grid' && props.columns !== undefined) {
      const columns = props.columns
      if (typeof columns !== 'number' || !Number.isInteger(columns) || columns < 1 || columns > 6) {
        return failNode(node, path, 'grid.columns 需要 1–6 的整数')
      }
    }
    const children = []
    if (spec.children && Array.isArray(node.children)) {
      for (const [index, child] of node.children.entries()) {
        const walked = walk(child, depth + 1, `${path}.children[${index}]`)
        if (walked === null) return null
        children.push(walked)
      }
    }
    return { id: typeof node.id === 'string' && node.id !== '' ? node.id : path, type: node.type, props, children }
  }

  const root = walk(input?.root, 1, 'root')
  // 根节点若只能降级，等于整份文档没有可信结构 → 整段拒绝（不做半残渲染）
  if (root !== null && root.degraded === true) fatal.push('根节点不合法')
  if (fatal.length > 0 || root === null) {
    return { ok: false, errors: fatal.length > 0 ? fatal : ['根节点不合法'], fallback: typeof input?.fallback === 'string' ? input.fallback : '' }
  }
  const state = input?.state ?? {}
  let stateBytes = Infinity
  try { stateBytes = JSON.stringify(state).length } catch { /* 循环或异常输入拒绝 */ }
  if (!isRecord(state) || !stateSafe(state) || stateBytes > LIMITS.stateBytes) {
    return { ok: false, errors: ['state 超过容量预算或包含不安全属性'], fallback: typeof input?.fallback === 'string' ? input.fallback : '' }
  }
  return {
    ok: true,
    errors: [],
    degraded,
    ast: { version: IUI_VERSION, state, root, fallback: typeof input?.fallback === 'string' ? input.fallback : '', title: typeof input?.title === 'string' ? input.title : '' },
  }
}

/** 表格归一：列可为字符串或 {key,label}，行可为二维数组或对象；输出纯二维字符串表。 */
export function tableMatrix(props) {
  const rawColumns = Array.isArray(props?.columns) ? props.columns : []
  const columns = rawColumns.map((column) => {
    if (typeof column === 'string') return { key: null, label: column }
    const key = typeof column?.key === 'string' ? column.key : null
    return { key, label: String(column?.label ?? column?.key ?? '') }
  })
  const matrix = (Array.isArray(props?.rows) ? props.rows : []).map((row) => {
    if (Array.isArray(row)) return columns.map((_, index) => row[index] ?? '')
    return columns.map((column) => {
      if (column.key !== null) return row?.[column.key] ?? ''
      return row?.[column.label] ?? ''
    })
  })
  return { columns: columns.map((column) => column.label), rows: matrix }
}

/** 局部降级：把一段文本包成合法的 text 节点（客户端/测试共用）。 */
export function degradeToText(text) {
  return { id: 'degraded', type: 'text', props: { text: String(text ?? '') }, children: [] }
}
