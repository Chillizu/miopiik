/**
 * miopiik-ml v1 —— 面向模型的声明式表达层（实验）。
 *
 * 三层分工：
 *   1) 本文件：模型可读的标签式声明 → 解析成**原始 AST 文档**（不校验预算/属性语义）；
 *   2) shared/iui-ast.js 的 validateAst：唯一校验器（白名单、绑定、预算、局部降级）；
 *   3) client 渲染器：只渲染通过校验的 AST。
 *
 * 语法（示意）：
 *   <ui title="周活跃" fallback="近7天活跃 45 次">
 *     <state>{"range":{"current":45}}</state>
 *     <column gap="10">
 *       <text>切换范围只改本地状态。</text>
 *       <row gap="12">
 *         <metric label="当前" value="$state.range.current" unit="次"/>
 *         <metric label="上一" value="$state.range.prev" unit="次"/>
 *       </row>
 *       <segmented label="范围" bind="$state.range" options='[{"label":"近7天","value":{}}]'/>
 *       <chart kind="bar" series="$state.range.series" source="示例"/>
 *     </column>
 *   </ui>
 *
 * 安全：标签白名单内才编译；属性只解析字面量/JSON/绑定，不执行任何代码；
 * 未知标签、未闭合标签只降级**各自子树**为文本，兄弟与父级保留。
 */

export const ML_VERSION = 'miop/1'

/** 标签 → AST 组件类型（映射表，不是第二套校验器）。 */
export const ML_TAGS = Object.freeze({
  ui: 'root',
  state: 'state',
  text: 'text',
  metric: 'metric',
  row: 'row',
  column: 'column',
  grid: 'grid',
  card: 'card',
  table: 'table',
  p: 'paragraph',
  paragraph: 'paragraph',
  badge: 'badge',
  icon: 'icon',
  b: 'emphasis',
  emphasis: 'emphasis',
  code: 'code',
  a: 'link',
  link: 'link',
  callout: 'callout',
  progress: 'progress',
  empty: 'empty',
  chart: 'chart',
  segmented: 'segmented',
  divider: 'divider',
})

const CONTAINERS = Object.freeze({ row: true, column: true, grid: true, card: true })
const VOID_TAGS = Object.freeze({ metric: true, divider: true, chart: true, segmented: true, table: true })

function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, '&')
}

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

/** 从 index 处的 '<' 解析一个标签；失败返回 null。 */
function readTag(source, index) {
  let i = index + 1
  let closing = false
  if (source[i] === '/') {
    closing = true
    i += 1
  }
  const nameStart = i
  while (i < source.length && /[A-Za-z0-9_-]/u.test(source[i])) i += 1
  const name = source.slice(nameStart, i)
  if (name === '') return null
  const attrs = {}
  let selfClosing = false
  let closed = false
  while (i < source.length) {
    const ch = source[i]
    if (ch === '>') {
      i += 1
      closed = true
      break
    }
    if (ch === '/') {
      selfClosing = true
      i += 1
      continue
    }
    if (isSpace(ch)) {
      i += 1
      continue
    }
    const keyStart = i
    while (i < source.length && !isSpace(source[i]) && source[i] !== '=' && source[i] !== '>' && source[i] !== '/') i += 1
    const key = source.slice(keyStart, i)
    if (key === '') {
      i += 1
      continue
    }
    let j = i
    while (j < source.length && isSpace(source[j])) j += 1
    if (source[j] !== '=') {
      attrs[key] = true
      i = j
      continue
    }
    j += 1
    while (j < source.length && isSpace(source[j])) j += 1
    const quote = source[j]
    if (quote === '"' || quote === "'") {
      const valueStart = j + 1
      let k = valueStart
      while (k < source.length && source[k] !== quote) k += 1
      attrs[key] = decodeEntities(source.slice(valueStart, k))
      i = k + 1
    } else {
      let k = j
      while (k < source.length && !isSpace(source[k]) && source[k] !== '>') k += 1
      attrs[key] = decodeEntities(source.slice(j, k))
      i = k
    }
  }
  return { name, closing, attrs, selfClosing, closed, end: i }
}

function parseDocument(source) {
  const text = String(source ?? '')
  const root = { name: '#root', attrs: {}, children: [], unclosed: false }
  const stack = [root]
  let cursor = 0
  let index = 0
  const pushText = (raw) => {
    if (raw.trim() === '') return
    stack[stack.length - 1].children.push({ name: '#text', text: decodeEntities(raw) })
  }
  while (index < text.length) {
    const lt = text.indexOf('<', index)
    if (lt < 0) break
    const next = text[lt + 1] ?? ''
    if (!/[A-Za-z/]/u.test(next)) {
      index = lt + 1
      continue
    }
    const tag = readTag(text, lt)
    if (tag === null) {
      index = lt + 1
      continue
    }
    pushText(text.slice(cursor, lt))
    cursor = tag.end
    index = tag.end
    if (tag.closing) {
      // 容错：向上找到最近同名开放元素；找不到就忽略这个闭合标签
      for (let depth = stack.length - 1; depth >= 1; depth -= 1) {
        if (stack[depth].name === tag.name) {
          stack.length = depth
          break
        }
      }
      continue
    }
    const element = { name: tag.name, attrs: tag.attrs, children: [], unclosed: false }
    stack[stack.length - 1].children.push(element)
    if (tag.selfClosing || VOID_TAGS[tag.name] === true) continue
    stack.push(element)
  }
  pushText(text.slice(cursor))
  // 未闭合：把打开的元素标记为 unclosed（编译时降级该子树），已读到的文本保留
  for (let depth = 1; depth < stack.length; depth += 1) stack[depth].unclosed = true
  return root
}

/** 元素内的纯文本（用于半截/降级时保留已写出的内容）。 */
function textOf(element) {
  if (element.name === '#text') return String(element.text ?? '')
  return element.children.map(textOf).join(' ').replace(/\s+/gu, ' ').trim()
}

/** 语义间距/对齐：模型写 md/lg 比写像素自然；未知值原样保留交给校验器。 */
const GAP_TOKENS = Object.freeze({ none: 0, xs: 2, sm: 6, md: 12, lg: 20, xl: 28 })

/** 受限属性正规化：只做**显式枚举**的改名与语义值转换，不做任意猜测。 */
function normalizeAttrs(element) {
  const attrs = { ...element.attrs }
  if (attrs.variant !== undefined && attrs.tone === undefined) {
    attrs.tone = attrs.variant
    delete attrs.variant
  }
  if (attrs.type !== undefined && attrs.kind === undefined && element.name === 'chart') {
    attrs.kind = attrs.type
    delete attrs.type
  }
  if (typeof attrs.gap === 'string' && GAP_TOKENS[attrs.gap] !== undefined) attrs.gap = GAP_TOKENS[attrs.gap]
  return attrs
}

/** 属性值：$state.* 保留绑定；JSON 字面量解析；数字转 number；其余按字符串。 */
function readValue(raw) {
  if (typeof raw !== 'string') return raw
  const text = raw.trim()
  if (text.startsWith('$')) return text
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null') return null
  if (/^-?\d+(?:\.\d+)?$/u.test(text)) return Number(text)
  return text
}

function readProps(attrs, keys) {
  const props = {}
  for (const key of keys) {
    if (attrs[key] !== undefined) props[key] = readValue(attrs[key])
  }
  return props
}

const TEXT_PROPS = Object.freeze({
  text: ['text'],
  p: ['gap'],
  paragraph: ['gap'],
  badge: ['text', 'tone'],
  emphasis: ['text', 'strong'],
  code: ['text'],
  a: ['text', 'href'],
  link: ['text', 'href'],
  icon: ['name', 'label'],
  callout: ['tone', 'title', 'text'],
  progress: ['label', 'value', 'max', 'tone'],
  empty: ['text', 'title', 'description', 'icon'],
  divider: ['label'],
  metric: ['label', 'value', 'unit', 'note', 'delta', 'caption', 'tone'],
  chart: ['kind', 'type', 'series', 'source', 'title'],
  segmented: ['label', 'bind', 'options'],
  table: ['columns', 'rows', 'caption'],
  card: ['title', 'subtitle', 'gap', 'span', 'align'],
  grid: ['columns', 'gap', 'align'],
  row: ['gap', 'align'],
  column: ['gap', 'align'],
})

/**
 * 解析 miopiik-ml 源码。
 * @returns {{ok:true, doc, degraded:string[]} | {ok:false, errors:string[], degraded:string[]}}
 */
export function parseMiopiikMl(source) {
  const root = parseDocument(source)
  const degraded = []
  const ui = root.children.find((node) => node.name === 'ui')
  if (ui === undefined) {
    return { ok: false, errors: ['缺少 <ui> 根标签'], degraded }
  }
  if (ui.unclosed) degraded.push('<ui> 没有闭合')

  let state = {}
  const children = []
  for (const child of ui.children) {
    if (child.name === '#text') {
      const raw = String(child.text ?? '').trim()
      if (raw !== '') children.push({ kind: 'degraded', text: raw })
      continue
    }
    if (child.name === 'state') {
      // 形态一：<state name="range" value='{...}' />
      if (typeof child.attrs.name === 'string' && child.attrs.name !== '') {
        const rawValue = child.attrs.value
        if (typeof rawValue === 'string' && rawValue.trim() !== '') {
          try {
            state[child.attrs.name] = JSON.parse(rawValue)
          } catch {
            degraded.push(`<state name="${child.attrs.name}"> 的 value 不是合法 JSON`)
          }
        } else {
          degraded.push(`<state name="${child.attrs.name}"> 缺少 value`)
        }
        continue
      }
      // 形态二：<state>{...}</state>
      const raw = child.children.map((node) => (node.name === '#text' ? node.text : '')).join('').trim()
      if (raw === '') continue
      try {
        const parsed = JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) state = { ...state, ...parsed }
        else degraded.push('<state> 需要 JSON 对象')
      } catch {
        degraded.push('<state> 不是合法 JSON')
      }
      continue
    }
    children.push(child)
  }

  const compile = (element) => {
    if (element.name === '#text') return { kind: 'degraded', text: decodeEntities(String(element.text ?? '')) }
    const type = ML_TAGS[element.name]
    const attrs = normalizeAttrs(element)
    const fallbackText = typeof attrs.fallback === 'string' ? attrs.fallback : ''
    const innerText = textOf(element)
    const degrade = (reason) => {
      degraded.push(`<${element.name}> ${reason}`)
      // 未闭合：保留已写出的文本；未知/非法标签：只给提示，绝不回显内容（避免把脚本源码摆到界面上）
      const text = fallbackText !== '' ? fallbackText : element.unclosed && innerText !== '' ? innerText : `（此段无法渲染：${reason}）`
      return { kind: 'degraded', text }
    }
    if (type === undefined || type === 'root' || type === 'state') return degrade('未知标签')
    if (element.unclosed) return degrade('没有闭合')
    const INLINE_LEAVES = { badge: 'text', emphasis: 'text', b: 'text', code: 'text', a: 'text', link: 'text', callout: 'text', progress: 'label', empty: 'text' }
    if (INLINE_LEAVES[element.name] !== undefined) {
      const key = INLINE_LEAVES[element.name]
      const props = readProps(attrs, TEXT_PROPS[element.name] ?? [])
      if (props[key] === undefined && innerText !== '') props[key] = innerText
      // empty：text 可由 title/description 派生；三者都没有才降级
      if (element.name === 'empty' && (props[key] === undefined || props[key] === '')) {
        const fallback = props.title ?? props.description
        if (fallback !== undefined && fallback !== '') props[key] = fallback
        else return degrade('没有内容')
      }
      if (props[key] === undefined || props[key] === '') return degrade('没有内容')
      return { kind: 'node', node: { id: typeof element.attrs.id === 'string' && element.attrs.id !== '' ? element.attrs.id : `ml-${element.name}`, type, props, children: [] } }
    }
    if (element.name === 'text') {
      const text = typeof element.attrs.text === 'string' ? element.attrs.text : innerText
      return text === '' ? degrade('没有内容') : { kind: 'node', node: { id: typeof element.attrs.id === 'string' && element.attrs.id !== '' ? element.attrs.id : 'ml-text', type: 'text', props: { text }, children: [] } }
    }
    if (element.name === 'callout' && element.children.some((child) => child.name !== '#text')) {
      const children = element.children
        .map((child) => {
          if (child.name === '#text') {
            const text = String(child.text ?? '').trim()
            return text === '' ? null : { id: 'ml-callout-text', type: 'text', props: { text }, children: [] }
          }
          const item = compile(child)
          return item.kind === 'node' ? item.node : { id: 'ml-callout-degraded', type: 'text', props: { text: item.text }, children: [] }
        })
        .filter(Boolean)
      const props = readProps(attrs, TEXT_PROPS.callout)
      return { kind: 'node', node: { id: typeof attrs.id === 'string' && attrs.id !== '' ? attrs.id : 'ml-callout', type: 'callout', props, children } }
    }
    if (element.name === 'p' || element.name === 'paragraph') {
      const children = element.children.map((child) => {
        if (child.name === '#text') {
          const text = String(child.text ?? '')
          return text.trim() === '' ? null : { id: 'ml-inline-text', type: 'text', props: { text }, children: [] }
        }
        const item = compile(child)
        return item.kind === 'node' ? item.node : { id: 'ml-inline-degraded', type: 'text', props: { text: item.text }, children: [] }
      }).filter(Boolean)
      if (children.length === 0) return degrade('段落为空')
      return { kind: 'node', node: { id: typeof attrs.id === 'string' && attrs.id !== '' ? attrs.id : 'ml-p', type: 'paragraph', props: readProps(attrs, ['gap']), children } }
    }
    if (CONTAINERS[element.name] === true) {
      const nodes = element.children.map((child) => compile(child))
      // 降级片段作为 text 节点保留在父布局里（局部降级，不整段丢弃）
      const children = nodes.map((item, index) =>
        item.kind === 'node' ? item.node : { id: `ml-degraded-${index}`, type: 'text', props: { text: item.text }, children: [] },
      )
      if (children.length === 0) return degrade('容器内没有可渲染内容')
      return {
        kind: 'node',
        node: {
          id: typeof attrs.id === 'string' && attrs.id !== '' ? attrs.id : `ml-${element.name}`,
          type,
          props: readProps(attrs, TEXT_PROPS[element.name] ?? []),
          children,
        },
      }
    }
    if (element.children.length > 0) return degrade('该标签不接受子内容')
    return { kind: 'node', node: { id: typeof element.attrs.id === 'string' && element.attrs.id !== '' ? element.attrs.id : `ml-${element.name}`, type, props: readProps(element.attrs, TEXT_PROPS[element.name] ?? []), children: [] } }
  }

  const compiled = children.map((child) => compile(child))
  const mapped = compiled.map((item, index) =>
    item.kind === 'node' ? item.node : { id: `ml-top-${index}`, type: 'text', props: { text: item.text }, children: [] },
  )
  let rootNode = null
  if (mapped.length === 1) rootNode = mapped[0]
  else if (mapped.length > 1) rootNode = { id: 'ml-root', type: 'column', props: { gap: 10 }, children: mapped }
  if (rootNode === null) return { ok: false, errors: ['<ui> 里没有可渲染内容'], degraded }

  // 稳定 key：同类型节点按出现顺序编号，回放与状态不漂移
  let counter = 0
  const assignIds = (node) => {
    counter += 1
    const id = `${node.id}#${counter}`
    return { ...node, id, children: node.children.map(assignIds) }
  }
  const withIds = assignIds(rootNode)

  return {
    ok: true,
    degraded,
    doc: {
      title: typeof ui.attrs.title === 'string' ? ui.attrs.title : '',
      fallback: typeof ui.attrs.fallback === 'string' ? ui.attrs.fallback : '',
      state,
      root: withIds,
    },
  }
}
