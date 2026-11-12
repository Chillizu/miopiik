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
      const literal = readBinding(props.series).literal
      if (Array.isArray(literal) && literal.length > LIMITS.series) return failNode(node, path, `series 超过 ${LIMITS.series} 点`)
    }
    if (node.type === 'text' && typeof props.text === 'string' && props.text.length > LIMITS.text) {
      return failNode(node, path, `text 超过 ${LIMITS.text} 字`)
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
  const state = isRecord(input.state) ? input.state : {}
  return {
    ok: true,
    errors: [],
    degraded,
    ast: { version: IUI_VERSION, state, root, fallback: typeof input?.fallback === 'string' ? input.fallback : '', title: typeof input?.title === 'string' ? input.title : '' },
  }
}
