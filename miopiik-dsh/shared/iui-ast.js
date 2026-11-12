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
  metric: { props: { label: 'string', value: 'value', unit: 'string?', note: 'string?' }, children: false },
  row: { props: { gap: 'number?' }, children: true },
  column: { props: { gap: 'number?' }, children: true },
  chart: { props: { kind: 'string', series: 'value', source: 'string?' }, children: false },
  segmented: { props: { label: 'string?', options: 'value', bind: 'string' }, children: false },
  divider: { props: {}, children: false },
})

export const LIMITS = Object.freeze({ nodes: 120, depth: 4, series: 60, options: 6, text: 2000 })

const BIND = /^\$(state|data)\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)$/u

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 只允许 `$state.x` / `$data.x`，其余原样返回。 */
export function readBinding(value) {
  if (typeof value !== 'string') return { literal: value }
  const match = BIND.exec(value)
  return match === null ? { literal: value } : { scope: match[1], key: match[2] }
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
 * 校验并规范化一棵 AST。
 * @returns {{ok:true, ast} | {ok:false, errors, fallback}}
 */
export function validateAst(input) {
  const errors = []
  let nodes = 0
  const walk = (node, depth, path) => {
    if (!isRecord(node)) {
      errors.push(`${path} 不是对象`)
      return null
    }
    if (depth > LIMITS.depth) {
      errors.push(`${path} 超过最大深度 ${LIMITS.depth}`)
      return null
    }
    nodes += 1
    if (nodes > LIMITS.nodes) {
      errors.push(`节点数超过 ${LIMITS.nodes}`)
      return null
    }
    const type = node.type
    const spec = REGISTRY[type]
    if (spec === undefined) {
      errors.push(`${path} 未知组件类型：${String(type)}`)
      return null
    }
    const props = isRecord(node.props) ? node.props : {}
    if (props.bind !== undefined) {
      const binding = readBinding(props.bind)
      if (binding.scope !== 'state') errors.push(`${path}.bind 只能绑定 $state.*`)
    }
    if (type === 'segmented' && (!Array.isArray(props.options) || props.options.length === 0 || props.options.length > LIMITS.options)) {
      errors.push(`${path}.options 必须是 1–${LIMITS.options} 项数组`)
    }
    if (type === 'chart') {
      const series = readBinding(props.series)
      const literal = series.literal
      if (Array.isArray(literal) && literal.length > LIMITS.series) errors.push(`${path}.series 超过 ${LIMITS.series} 点`)
    }
    if (type === 'text' && typeof props.text === 'string' && props.text.length > LIMITS.text) errors.push(`${path}.text 超过 ${LIMITS.text} 字`)
    const children = spec.children && Array.isArray(node.children) ? node.children.map((child, index) => walk(child, depth + 1, `${path}.children[${index}]`)).filter(Boolean) : []
    return { id: typeof node.id === 'string' && node.id !== '' ? node.id : path, type, props, children }
  }
  const ast = walk(input.root, 1, 'root')
  if (ast === null || errors.length > 0) {
    return { ok: false, errors, fallback: typeof input?.fallback === 'string' ? input.fallback : '' }
  }
  const state = isRecord(input.state) ? input.state : {}
  return { ok: true, errors: [], ast: { version: IUI_VERSION, state, root: ast, fallback: typeof input.fallback === 'string' ? input.fallback : '', title: typeof input.title === 'string' ? input.title : '' } }
}

/** 局部降级：把一棵不合法子树换成 fallback 文本节点。 */
export function degradeToText(text) {
  return { id: 'degrade', type: 'text', props: { text: String(text ?? '') }, children: [] }
}
