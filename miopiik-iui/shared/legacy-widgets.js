/**
 * 旧展示协议 → iui/1 AST 的**只读** adapter。
 *
 * 旧会话里模型写的是 fenced ```ink-view + 七种 widget spec。渲染器已经退役，
 * 但历史消息不能丢：这里把旧 spec 映射成新 AST，再走同一套 validateAst 与新渲染器。
 * 规则：
 *  - 只读，绝不写回、不改原始 JSONL；
 *  - 映射不了的 widget（如 mermaid）返回失败，由调用方显示旧 spec 自带的 fallback 文本；
 *  - 所有产出仍要经过 validateAst，预算/安全边界不变。
 */

const WIDGET_KINDS = Object.freeze(['dataset', 'graph', 'timeline', 'text', 'choice', 'media', 'layout'])

let counter = 0
const nextId = (prefix) => `${prefix}-${(counter += 1)}`

function textNode(text) {
  return { id: nextId('legacy-text'), type: 'text', props: { text: String(text) }, children: [] }
}

function paragraphNode(text) {
  return { id: nextId('legacy-p'), type: 'paragraph', children: [textNode(text)] }
}

function columnNode(children) {
  return { id: nextId('legacy-col'), type: 'column', props: { gap: 8 }, children }
}

function labelsOf(columns) {
  if (!Array.isArray(columns)) return []
  return columns.map((column) => {
    if (typeof column === 'string') return column
    if (column !== null && typeof column === 'object') return String(column.label ?? column.key ?? '')
    return ''
  })
}

function tableNode(columns, rows) {
  return { id: nextId('legacy-table'), type: 'table', props: { columns, rows }, children: [] }
}

function mapDataset(props) {
  const labels = labelsOf(props.columns)
  const rows = Array.isArray(props.rows) ? props.rows.filter((row) => Array.isArray(row)) : []
  if (props.chart !== undefined && props.chart !== false && rows.length > 0) {
    const series = rows.map((row) => [String(row[0] ?? ''), Number(row[1]) || 0])
    const rawKind = props.chart === true ? 'bar' : String(props.chart)
    const kind = rawKind === 'line' ? 'line' : 'bar' // donut/其他旧值降级为柱状
    const propsOut = { kind, series }
    if (typeof props.source === 'string' && props.source !== '') propsOut.source = props.source
    return { id: nextId('legacy-chart'), type: 'chart', props: propsOut, children: [] }
  }
  if (rows.length === 0) return textNode(labels.join(' / ') || '表格（无数据）')
  return tableNode(labels, rows.map((row) => row.map((cell) => (cell === null || cell === undefined ? '' : String(cell)))))
}

function mapText(props) {
  const children = []
  for (const paragraph of Array.isArray(props.paragraphs) ? props.paragraphs : []) children.push(paragraphNode(paragraph))
  for (const bullet of Array.isArray(props.bullets) ? props.bullets : []) children.push(paragraphNode(`• ${bullet}`))
  return children.length === 0 ? null : columnNode(children)
}

function mapTimeline(props) {
  const items = Array.isArray(props.items) ? props.items : []
  if (items.length === 0) return null
  const rows = items.map((item) => [String(item?.at ?? ''), String(item?.label ?? ''), String(item?.note ?? '')])
  return tableNode(['时间', '事件', '说明'], rows)
}

function mapGraph(props) {
  const nodes = Array.isArray(props.nodes) ? props.nodes : []
  const edges = Array.isArray(props.edges) ? props.edges : []
  const parts = []
  if (nodes.length > 0) parts.push(tableNode(['节点', '标签', '泳道'], nodes.map((node) => [String(node?.id ?? ''), String(node?.label ?? ''), String(node?.lane ?? '')])))
  if (edges.length > 0) parts.push(tableNode(['从', '到', '标签'], edges.map((edge) => [String(edge?.from ?? ''), String(edge?.to ?? ''), String(edge?.label ?? '')])))
  return parts.length === 0 ? null : columnNode(parts)
}

function mapChoice(props) {
  const actions = Array.isArray(props.actions) ? props.actions : []
  const options = actions.map((action) => String(action?.label ?? '')).filter(Boolean)
  return {
    id: nextId('legacy-callout'),
    type: 'callout',
    props: {
      tone: 'neutral',
      title: String(props.question ?? ''),
      text: options.length > 0 ? `选项（v1 只读，点击不会执行）：${options.join(' / ')}` : '选项（v1 只读）',
    },
    children: [],
  }
}

function mapMedia(props) {
  if (typeof props.url === 'string' && /^https:\/\//u.test(props.url)) {
    return paragraphNode(`图片：${props.url}`)
  }
  if (typeof props.path === 'string') return paragraphNode(`本地图片：${props.path}`)
  return null
}

function mapLayout(props) {
  const children = Array.isArray(props.children) ? props.children.map(mapSpec).filter(Boolean) : []
  if (children.length === 0) return null
  const direction = props.direction === 'row' ? 'row' : props.direction === 'grid' ? 'grid' : 'column'
  return { id: nextId('legacy-layout'), type: direction, props: direction === 'grid' && Number.isInteger(props.columns) ? { columns: props.columns } : {}, children }
}

function mapSpec(spec) {
  if (spec === null || typeof spec !== 'object' || !WIDGET_KINDS.includes(spec.widget)) return null
  const props = spec.props !== null && typeof spec.props === 'object' ? spec.props : {}
  switch (spec.widget) {
    case 'dataset': return mapDataset(props)
    case 'text': return mapText(props)
    case 'timeline': return mapTimeline(props)
    case 'graph': return mapGraph(props)
    case 'choice': return mapChoice(props)
    case 'media': return mapMedia(props)
    case 'layout': return mapLayout(props)
    default: return null
  }
}

/**
 * @param input 旧版 ink-view spec（不可信）
 * @returns {{ok:true, doc:object, widget:string} | {ok:false, errors:string[], fallback:string}}
 */
export function adoptLegacySpec(input) {
  if (input === null || typeof input !== 'object' || typeof input.widget !== 'string') {
    return { ok: false, errors: ['不是旧版 widget spec'], fallback: '' }
  }
  const fallback = typeof input.fallback === 'string' ? input.fallback : ''
  if (!WIDGET_KINDS.includes(input.widget)) {
    return { ok: false, errors: [`旧窗口类型 ${input.widget} 无法映射到新渲染器`], fallback }
  }
  const root = mapSpec(input)
  if (root === null) return { ok: false, errors: [`旧窗口 ${input.widget} 没有可映射内容`], fallback }
  return {
    ok: true,
    widget: input.widget,
    doc: {
      version: 'iui/1',
      title: typeof input.title === 'string' ? input.title : '',
      fallback,
      state: {},
      root,
    },
  }
}
