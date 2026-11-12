/**
 * Extra 展示层协议规则的唯一真源（Host 与 Client 共用）。
 *
 * 为什么单独成文件：DSH 的 client 插件文件是按 module-loader 的工厂格式**原样下发**的，
 * 浏览器侧不能 `import` 宿主模块。所以这里写成「纯函数 + 常量、零依赖」的 ESM，
 * Host 直接 import；Client 由 tools/build-client-rules.mjs 把同一份代码内联进 client.js
 * （带 markers），并由 test/schema-drift.test.js 防止两边漂移。
 *
 * 协议 v2.1：{ protocol, v, widget, preset, title, props, fallback }
 * 与 v2 相比只收紧校验，不改变可接受的形状。
 */

export const UI_PROTOCOL = 'miopiik-ui/0.2'

export const WIDGET_KINDS = Object.freeze(['dataset', 'graph', 'timeline', 'text', 'choice', 'media', 'layout'])
export const WIDGET_PRESETS = Object.freeze(['card', 'plain', 'inset', 'stat'])
export const ACTION_KINDS = Object.freeze(['local', 'read', 'write', 'sensitive'])
export const MEDIA_KINDS = Object.freeze(['image', 'link'])
export const CHART_KINDS = Object.freeze(['bar', 'line', 'donut'])
export const LAYOUT_DIRECTIONS = Object.freeze(['stack', 'row', 'grid'])

export const LIMITS = Object.freeze({
  title: 80,
  fallback: 300,
  textField: 4000,
  rows: 200,
  columns: 12,
  nodes: 60,
  edges: 120,
  actions: 2,
  children: 6,
  depth: 2,
})

/** 本地图只允许落在会话的 charts 目录里（Host 生成的图），不接受任意绝对路径。 */
export const MEDIA_PATH_PATTERN = /\/\.dsh\/miopiik\/sessions\/[^/]+\/charts\/[^/]+\.(?:svg|png|jpe?g|webp|gif)$/iu

export function isAllowedMediaPath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 1024 && MEDIA_PATH_PATTERN.test(path)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isText(value) {
  return typeof value === 'string'
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 只保留协议允许的字段：多余的键一律丢弃，避免模型顺手塞样式。 */
function pickProps(widget, props) {
  if (!isRecord(props)) return {}
  const keep = {
    dataset: ['columns', 'rows', 'chart', 'unit'],
    graph: ['nodes', 'edges'],
    timeline: ['items'],
    text: ['paragraphs', 'bullets'],
    choice: ['question', 'actions'],
    media: ['url', 'path', 'kind', 'alt', 'label'],
    layout: ['direction', 'children'],
  }[widget] ?? []
  const picked = {}
  for (const key of keep) if (props[key] !== undefined) picked[key] = props[key]
  for (const extra of ['unit', 'source', 'note']) {
    if (isText(props[extra]) && props[extra].trim() !== '') picked[extra] = props[extra].slice(0, 160)
  }
  return picked
}

function validateDataset(props, errors) {
  const columns = props.columns
  if (!Array.isArray(columns) || columns.length === 0) errors.push('dataset 需要 columns')
  else if (columns.length > LIMITS.columns) errors.push(`dataset 最多 ${LIMITS.columns} 列`)
  const rows = props.rows
  if (!Array.isArray(rows)) {
    errors.push('dataset 需要 rows')
    return
  }
  if (rows.length > LIMITS.rows) errors.push(`dataset 最多 ${LIMITS.rows} 行`)
  for (const [index, row] of rows.entries()) {
    if (!Array.isArray(row)) {
      errors.push(`dataset 第 ${index + 1} 行必须是数组`)
      continue
    }
    for (const cell of row) {
      if (isText(cell) ? cell.length > LIMITS.textField : !finite(cell) && typeof cell !== 'boolean' && cell !== null) {
        errors.push(`dataset 第 ${index + 1} 行的单元格不合法`)
        break
      }
    }
  }
  if (props.chart !== undefined) {
    const chart = props.chart === true ? 'bar' : props.chart
    if (!CHART_KINDS.includes(chart)) errors.push(`chart 只能是 ${CHART_KINDS.join('/')} 或 true`)
    for (const [index, row] of rows.entries()) {
      if (!Array.isArray(row) || row.length < 2) continue
      const value = row[1]
      if (!finite(value)) errors.push(`dataset 第 ${index + 1} 行的数值必须是有限数字`)
      else if (value < 0) errors.push(`dataset 第 ${index + 1} 行的数值不能是负数`)
      else if (value > 1e12) errors.push(`dataset 第 ${index + 1} 行的数值过大`)
    }
  }
}

function validateGraph(props, errors) {
  const nodes = props.nodes
  if (!Array.isArray(nodes) || nodes.length === 0) {
    errors.push('graph 需要 nodes')
    return
  }
  if (nodes.length > LIMITS.nodes) errors.push(`graph 最多 ${LIMITS.nodes} 个节点`)
  const ids = new Set()
  for (const [index, node] of nodes.entries()) {
    if (!isRecord(node)) {
      errors.push(`graph 第 ${index + 1} 个节点必须是对象`)
      continue
    }
    if (!isText(node.id) || node.id.trim() === '') errors.push(`graph 第 ${index + 1} 个节点需要 id`)
    else if (ids.has(node.id)) errors.push(`graph 节点 id 重复：${node.id}`)
    else ids.add(node.id)
    if (node.label !== undefined && !isText(node.label)) errors.push(`graph 第 ${index + 1} 个节点的 label 必须是字符串`)
    if (node.lane !== undefined && !isText(node.lane)) errors.push(`graph 第 ${index + 1} 个节点的 lane 必须是字符串`)
  }
  const edges = props.edges
  if (edges === undefined) return
  if (!Array.isArray(edges)) {
    errors.push('graph 的 edges 必须是数组')
    return
  }
  if (edges.length > LIMITS.edges) errors.push(`graph 最多 ${LIMITS.edges} 条边`)
  for (const [index, edge] of edges.entries()) {
    if (!isRecord(edge)) {
      errors.push(`graph 第 ${index + 1} 条边必须是对象`)
      continue
    }
    if (!isText(edge.from) || !isText(edge.to)) errors.push(`graph 第 ${index + 1} 条边需要 from/to`)
    else if (ids.size > 0 && (!ids.has(edge.from) || !ids.has(edge.to))) errors.push(`graph 第 ${index + 1} 条边引用了不存在的节点`)
    if (edge.label !== undefined && !isText(edge.label)) errors.push(`graph 第 ${index + 1} 条边的 label 必须是字符串`)
  }
}

function validateTimeline(props, errors) {
  const items = props.items
  if (!Array.isArray(items) || items.length === 0) {
    errors.push('timeline 需要 items')
    return
  }
  if (items.length > 24) errors.push('timeline 最多 24 项')
  for (const [index, item] of items.entries()) {
    if (!isRecord(item) || !isText(item.label) || item.label.trim() === '') {
      errors.push(`timeline 第 ${index + 1} 项需要 label`)
    }
  }
}

function validateChoice(props, errors) {
  if (!isText(props.question) || props.question.trim() === '') errors.push('choice 需要 question')
  const actions = props.actions
  if (!Array.isArray(actions) || actions.length === 0) {
    errors.push('choice 需要 actions')
    return
  }
  if (actions.length > LIMITS.actions) errors.push(`choice 最多 ${LIMITS.actions} 个动作`)
  for (const [index, action] of actions.entries()) {
    if (!isRecord(action) || !isText(action.label) || action.label.trim() === '') {
      errors.push(`choice 第 ${index + 1} 个动作需要 label`)
      continue
    }
    if (action.kind !== undefined && !ACTION_KINDS.includes(action.kind)) {
      errors.push(`choice 第 ${index + 1} 个动作的 kind 只能是 ${ACTION_KINDS.join('/')}`)
    }
  }
}

function validateMedia(props, errors) {
  const hasUrl = isText(props.url) && /^https?:\/\//iu.test(props.url)
  if (props.path !== undefined) {
    if (!isAllowedMediaPath(props.path)) {
      errors.push('media.path 只接受会话 charts 目录下的图片（Host 生成的图）；本地图请用 ink_chart 返回的 markdown 图')
    }
  } else if (!hasUrl) {
    errors.push('media 需要 http(s) 的 url，或 charts 目录下的 path')
  }
  if (props.kind !== undefined && !MEDIA_KINDS.includes(props.kind)) errors.push(`media.kind 只能是 ${MEDIA_KINDS.join('/')}`)
}

function validateLayout(props, errors, depth) {
  if (!LAYOUT_DIRECTIONS.includes(props.direction)) errors.push(`layout 的 direction 只能是 ${LAYOUT_DIRECTIONS.join('/')}`)
  const children = props.children
  if (!Array.isArray(children) || children.length === 0) {
    errors.push('layout 需要 children')
    return []
  }
  if (children.length > LIMITS.children) errors.push(`layout 最多 ${LIMITS.children} 个子项`)
  const normalized = []
  for (const [index, child] of children.entries()) {
    const checked = validateSpec(child, { depth: depth + 1 })
    if (!checked.ok) {
      errors.push(`layout 第 ${index + 1} 个子项不合法：${checked.errors.join('；')}`)
      continue
    }
    normalized.push(checked.spec)
  }
  return normalized
}

/**
 * 校验并规范化一份 spec。
 * @param input 模型产出的原始 spec（不可信）
 * @param options.depth 当前嵌套深度（内部用）
 * @returns {{ok:boolean, errors:string[], available?:readonly string[], spec?:object, fallbackText?:string}}
 */
export function validateSpec(input, options = {}) {
  const depth = finite(options.depth) ? options.depth : 1
  if (!isRecord(input)) return { ok: false, errors: ['spec 必须是对象'], available: WIDGET_KINDS }
  const widget = input.widget
  if (!WIDGET_KINDS.includes(widget)) {
    return { ok: false, errors: [`未知 widget: ${String(widget)}`], available: WIDGET_KINDS }
  }
  if (depth > LIMITS.depth) {
    return { ok: false, errors: [`layout 最深 ${LIMITS.depth} 层`], available: WIDGET_KINDS }
  }
  const preset = input.preset === undefined ? 'card' : input.preset
  if (!WIDGET_PRESETS.includes(preset)) {
    return { ok: false, errors: [`未知 preset: ${String(preset)}`], available: WIDGET_PRESETS }
  }
  const fallback = isText(input.fallback) ? input.fallback.trim() : ''
  if (fallback === '') return { ok: false, errors: ['fallback 必填：它是导出与降级的唯一出口'], available: WIDGET_KINDS }
  if (fallback.length > LIMITS.fallback) return { ok: false, errors: [`fallback 不超过 ${LIMITS.fallback} 字`], available: WIDGET_KINDS }
  const title = isText(input.title) ? input.title.trim() : ''
  if (title.length > LIMITS.title) return { ok: false, errors: [`title 不超过 ${LIMITS.title} 字`], available: WIDGET_KINDS }

  const props = pickProps(widget, input.props ?? {})
  const errors = []
  if (widget === 'dataset') validateDataset(props, errors)
  else if (widget === 'graph') validateGraph(props, errors)
  else if (widget === 'timeline') validateTimeline(props, errors)
  else if (widget === 'text') {
    const paragraphs = Array.isArray(props.paragraphs) ? props.paragraphs : null
    const bullets = Array.isArray(props.bullets) ? props.bullets : null
    if (paragraphs === null && bullets === null) errors.push('text 需要 paragraphs 或 bullets')
    for (const list of [paragraphs, bullets]) {
      if (list === null) continue
      for (const [index, item] of list.entries()) {
        if (!isText(item) || item.length > LIMITS.textField) errors.push(`text 第 ${index + 1} 条不合法`)
      }
    }
  } else if (widget === 'choice') validateChoice(props, errors)
  else if (widget === 'media') validateMedia(props, errors)
  else if (widget === 'layout') {
    const children = validateLayout(props, errors, depth)
    if (children.length > 0) props.children = children
  }
  if (errors.length > 0) return { ok: false, errors, available: WIDGET_KINDS }
  return {
    ok: true,
    errors: [],
    spec: { protocol: UI_PROTOCOL, v: 2, widget, preset, title, props, fallback },
    fallbackText: fallback,
  }
}

/** 嵌套深度。 */
export function layoutDepth(spec) {
  if (!isRecord(spec) || spec.widget !== 'layout') return 0
  const children = Array.isArray(spec.props?.children) ? spec.props.children : []
  return 1 + Math.max(0, ...children.map((child) => layoutDepth(child)))
}

/** 给导出/Markdown 用的纯文本（永远可读）。 */
export function widgetFallbackText(spec) {
  if (!isRecord(spec)) return ''
  return isText(spec.fallback) ? spec.fallback.trim() : ''
}
