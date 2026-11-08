/**
 * Extra 展示层 v1 —— SPEC §12（不碰核心：不写两份日志、不改闸门、不占 L3 预算）。
 *
 * 一个 IR，五个投影：dataset / graph / timeline / text / choice / media，外加 layout 容器。
 * spec 是数据，不是像素：落盘的是 {widget, props, fallback}，渲染器负责长相；
 * 引擎不认识的 widget 一律报错并列出可用清单——不静默降级。
 */

export const WIDGET_KINDS = Object.freeze([
  'dataset',
  'graph',
  'timeline',
  'text',
  'choice',
  'media',
  'layout',
])

const NUMERIC = (value) => typeof value === 'number' && Number.isFinite(value)

function validateProps(widget, props) {
  const errors = []
  if (widget === 'dataset') {
    if (!Array.isArray(props?.columns) || props.columns.length === 0) errors.push('dataset 需要 columns')
    if (!Array.isArray(props?.rows)) errors.push('dataset 需要 rows')
    else if (!props.rows.every((row) => Array.isArray(row))) errors.push('dataset 的 rows 必须是二维数组')
  }
  if (widget === 'graph') {
    if (!Array.isArray(props?.nodes) || props.nodes.length === 0) errors.push('graph 需要 nodes')
    if (props?.edges !== undefined && !Array.isArray(props.edges)) errors.push('graph 的 edges 必须是数组')
  }
  if (widget === 'timeline') {
    if (!Array.isArray(props?.items) || props.items.length === 0) errors.push('timeline 需要 items')
    else if (!props.items.every((item) => item !== null && typeof item === 'object' && 'label' in item)) {
      errors.push('timeline 的每一项需要 label')
    }
  }
  if (widget === 'text') {
    if (typeof props?.title !== 'string' || props.title.trim() === '') {
      // title 可省，但 content 必须有
      const hasBody = Array.isArray(props?.paragraphs) || Array.isArray(props?.bullets)
      if (!hasBody) errors.push('text 需要 paragraphs 或 bullets')
    }
  }
  if (widget === 'choice') {
    if (typeof props?.question !== 'string' || props.question.trim() === '') errors.push('choice 需要 question')
    if (!Array.isArray(props?.actions) || props.actions.length === 0) errors.push('choice 需要 actions')
    else if (props.actions.length > 2) errors.push('choice 最多两个动作')
  }
  if (widget === 'media') {
    if (typeof props?.url !== 'string' || !/^https?:\/\//u.test(props.url)) errors.push('media 需要 http(s) 的 url')
  }
  if (widget === 'layout') {
    if (!['stack', 'row', 'grid'].includes(props?.direction)) errors.push('layout 的 direction 只能是 stack/row/grid')
    if (!Array.isArray(props?.children) || props.children.length === 0) errors.push('layout 需要 children')
    else if (props.children.length > 6) errors.push('layout 最多 6 个子项')
  }
  return errors
}

/** 校验一份 spec。返回 { ok, errors, spec, fallbackText }。 */
export function validateWidget(input) {
  if (input === null || typeof input !== 'object') {
    return { ok: false, errors: ['spec 必须是对象'], available: WIDGET_KINDS }
  }
  const widget = input.widget
  if (!WIDGET_KINDS.includes(widget)) {
    return { ok: false, errors: [`未知 widget: ${widget}`], available: WIDGET_KINDS }
  }
  const fallback = typeof input.fallback === 'string' ? input.fallback.trim() : ''
  if (fallback === '') return { ok: false, errors: ['fallback 必填：它是导出与降级的唯一出口'], available: WIDGET_KINDS }
  const props = input.props ?? {}
  const errors = validateProps(widget, props)
  if (errors.length > 0) return { ok: false, errors, available: WIDGET_KINDS }
  return {
    ok: true,
    errors: [],
    spec: { widget, title: typeof input.title === 'string' ? input.title : '', props, fallback, v: 1 },
    fallbackText: fallback,
  }
}

/** 嵌套上限：layout 里再套 layout 只允许一层（深度 ≤2）。 */
export function layoutDepth(spec) {
  if (spec?.widget !== 'layout') return 0
  const children = Array.isArray(spec.props?.children) ? spec.props.children : []
  return 1 + Math.max(0, ...children.map((child) => layoutDepth(child)))
}

/** 给导出/Markdown 用的纯文本（永远可读）。 */
export function widgetFallbackText(spec) {
  if (spec === null || typeof spec !== 'object') return ''
  const text = typeof spec.fallback === 'string' ? spec.fallback.trim() : ''
  return text
}
