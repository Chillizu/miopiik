import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'

const root = new URL('../', import.meta.url)
const clientPath = new URL('client.js', root)

// 一个面：插件页（plugins.bundle.config）上面一句话介绍、下面 4 个真实控件，
// 控件经 configForms.get('miopiik-dsh') 实时读写当前生效配置。
const SLOT_NAMES = ['plugins.bundle.config']

/** 模拟 DSH settings 服务的表单（snapshot/subscribe/mutate）并记录调用。 */
function makeFakeForm({
  status = 'ready',
  value = {},
  base = {},
  user = {},
  revision = 0,
  writable = true,
  defaults = {},
  accept = true,
} = {}) {
  let snapshot = { status, value, base, user, revision, writable }
  const listeners = new Set()
  const calls = { mutate: [] }
  return {
    calls,
    get snapshot() {
      return snapshot
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async mutate(ops, expectedRevision) {
      calls.mutate.push({ ops, expectedRevision })
      if (accept !== true) return false
      // 折叠进快照：set 写 value+user，unset 撤销覆盖并回到默认值。
      const nextValue = { ...snapshot.value }
      const nextUser = { ...snapshot.user }
      for (const op of ops) {
        const key = op.path[0]
        if (op.op === 'set') {
          nextValue[key] = op.value
          nextUser[key] = op.value
        } else {
          delete nextUser[key]
          nextValue[key] = defaults[key]
        }
      }
      snapshot = { ...snapshot, value: nextValue, user: nextUser, revision: snapshot.revision + 1 }
      for (const listener of listeners) listener()
      return true
    },
  }
}

/** 带最小 hooks 实现的 React 桩：walk 期间函数组件执行，状态落在按次序复用的单元里。 */
function makeReactStub() {
  const hooks = []
  let cursor = 0
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      const index = cursor++
      const cell = hooks[index] ?? { value: typeof initial === 'function' ? initial() : initial }
      hooks[index] = cell
      return [
        cell.value,
        (next) => {
          cell.value = typeof next === 'function' ? next(cell.value) : next
        },
      ]
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const index = cursor++
      const cell = hooks[index] ?? {}
      hooks[index] = cell
      if (cell.subscribe !== subscribe) {
        cell.subscribe = subscribe
        cell.unsub?.()
        cell.unsub = subscribe?.(() => {})
      }
      return getSnapshot()
    },
    useEffect(fn) {
      fn()
      return () => {}
    },
  }
  return {
    React,
    // 每趟渲染前重置游标；hook 单元按调用次序跨渲染复用。
    beginComponent: () => {
      cursor = 0
    },
    endComponent: () => {},
  }
}

/** Render host nodes recursively; function components receive their props. */
function render(node, stub) {
  if (node === null || node === undefined || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap((child) => render(child, stub))
  if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }), stub)
  return [node, ...(node.children ?? []).flatMap((child) => render(child, stub))]
}

function slotBy(slots, name) {
  const entry = slots.find((slot) => slot.meta.name === name)
  assert.ok(entry !== undefined, 'missing slot: ' + name)
  return entry
}

/**
 * 装载 client.js 并把插件页跑起来。
 * form 形参注入 configForms.get() 的返回值；null 模拟「没有 settings 服务」。
 * walk() 每次完整渲染一趟并返回扁平节点表；事件处理器只改 hook 单元，
 * 下一次 walk 自然读到新状态。
 */
function loadAgentSettings({ form } = {}) {
  const source = readFileSync(clientPath, 'utf8')
  let module
  const sandbox = { console }
  sandbox.window = sandbox
  sandbox.__ModuleLoader__ = { load(value) { module = value } }
  createContext(sandbox)
  new Script(source, { filename: 'client.js' }).runInContext(sandbox, { timeout: 3000 })
  assert.equal(module.id, 'miopiik-dsh')

  const stub = makeReactStub()
  const plugin = module.factory((name) => {
    if (name === 'react') return stub.React
    // Primitive UI is optional; the page must stay renderable without it.
    throw new Error('unexpected dependency: ' + name)
  })

  const slots = []
  plugin.apply({
    effect() {},
    inject(names, callback) {
      if (names.includes('configForms')) callback({ configForms: { get: () => form ?? null } })
    },
    locale: { bind() { return (key) => key } },
    slots: {
      inject(name, callback) {
        // 其它插槽（conversation.view 等）在本页测试里不关心。
        if (SLOT_NAMES.includes(name)) callback()
      },
      register(meta, renderFn) {
        slots.push({ meta, render: renderFn })
        return () => {}
      },
    },
  })

  const walk = () => {
    stub.beginComponent()
    const element = slotBy(slots, 'plugins.bundle.config').render({ view: 'page' })
    return render(element, stub)
  }
  return { plugin, slots, source, stub, walk }
}

function text(nodes) {
  return nodes
    .flatMap((node) => (node.children ?? []).filter((child) => typeof child === 'string'))
    .join(' ')
}

/** 跨 realm 的 await 需要多个微任务节拍；用一次宏任务保证异步收尾全部落地。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** VM 里创建的对象与测试 realm 的原型不同，结构比对前先过一遍 JSON。 */
const plain = (value) => JSON.parse(JSON.stringify(value))

const FIELD_DEFAULTS = {
  conversationCompile: true,
  operatorModel: null,
  activeLoopCap: 12,
  operatorTimeoutMs: 1200000,
}

const FIELD_VALUES = {
  conversationCompile: true,
  operatorModel: 'opencode-go/glm-5.3',
  activeLoopCap: 12,
  operatorTimeoutMs: 1200000,
}

const inputOf = (nodes, key) => nodes.find((node) => node.props?.['data-miopiik-input'] === key)
const buttonOf = (nodes, label) =>
  nodes.find((node) => node.type === 'button' && String(node.children[0]).startsWith(label))

test('MiOpIIk Agent 只注册插件页一个配置面，settings.plugins.tab 占坑已撤', () => {
  const { plugin, slots, source } = loadAgentSettings({ form: makeFakeForm() })
  assert.ok(plugin.inject.includes('slots'))
  assert.equal(slots.length, 1)
  const bundle = slotBy(slots, 'plugins.bundle.config')
  assert.equal(bundle.meta.key, 'miopiik-dsh')
  assert.equal(slots.some((slot) => slot.meta.name === 'settings.plugins.tab'), false, '不该再注册 settings.plugins.tab')
  assert.doesNotMatch(source, /settings\.plugins\.tab/u, 'client.js 里连注释都不该再提这个 slot')
  assert.doesNotMatch(source, /'settings\.tab'/u, 'settings.tab 文案键应随页签一起撤除')
  assert.doesNotMatch(source, /ctx\.slots\.inject\('settings\.section'/u)
  assert.doesNotMatch(source, /globalThis\.__miopiikMarkdownEmbeds\s*=/u)
})

test('插件页上半部分只有一句话介绍，不再有架构长文与组件表', () => {
  const load = loadAgentSettings({ form: makeFakeForm() })
  const nodes = load.walk()
  assert.equal(nodes.filter((node) => node.props?.role === 'tab').length, 0, '插件页不该有二级页签')
  const overview = nodes.find((node) => node.props?.['data-miopiik-overview'] === '1')
  assert.ok(overview, '介绍应在插件页上半部分')
  const overviewText = text([overview, ...(overview.children ?? [])])
  // 一句话：以句号收尾且全文只有这一个句末标点。
  assert.ok(overviewText.endsWith('。'), '介绍应以句号收尾')
  assert.equal((overviewText.match(/。/gu) ?? []).length, 1, '介绍必须只有一句话')
  assert.ok(overviewText.length <= 120, `介绍应保持一句话的长度（当前 ${overviewText.length} 字）`)
  assert.match(overviewText, /Mind/u)
  assert.match(overviewText, /Ink/u)
  assert.match(overviewText, /Operator/u)
  // 旧的长文与组件表彻底消失。
  const body = text(nodes)
  assert.ok(!nodes.some((node) => node.props?.['data-miopiik-architecture'] === '1'), '架构长文区块应删除')
  assert.doesNotMatch(body, /组件信息/u, '组件表应删除')
  assert.doesNotMatch(body, /账本路径/u, '账本路径等死表格内容应删除')
  assert.doesNotMatch(body, /版本|独立插件|miopiik-iui/u, '版本与渲染层关系等只读事实应删除')
  // 介绍区只应有一个段落（p），且没有列表/表格结构。
  assert.equal(nodes.filter((node) => node.type === 'p' && node.props?.style?.fontSize === 14).length, 1, '介绍区只应有一个段落')
})

test('插件页下半部分是 4 个真实控件：经 configForms 读当前值，保存走 mutate', async () => {
  const form = makeFakeForm({
    value: { ...FIELD_VALUES },
    base: {},
    user: { activeLoopCap: 16, operatorModel: 'opencode-go/glm-5.3' },
    revision: 7,
    defaults: FIELD_DEFAULTS,
  })
  const load = loadAgentSettings({ form })
  let nodes = load.walk()

  assert.ok(nodes.some((node) => node.props?.['data-miopiik-configuration'] === '1'), '配置应在插件页下半部分')

  // 恰好 4 个输入控件，类型与键一一对应，初值来自 snapshot.value。
  const inputs = nodes.filter((node) => node.type === 'input')
  assert.equal(inputs.length, 4, '只应有 4 个控件')
  assert.deepEqual(
    inputs.map((node) => node.props['data-miopiak-input'] ?? node.props['data-miopiik-input']).sort(),
    [...Object.keys(FIELD_DEFAULTS)].sort(),
  )
  assert.equal(inputOf(nodes, 'conversationCompile').props.type, 'checkbox')
  assert.equal(inputOf(nodes, 'conversationCompile').props.checked, true)
  assert.equal(inputOf(nodes, 'operatorModel').props.type, 'text')
  assert.equal(inputOf(nodes, 'operatorModel').props.value, 'opencode-go/glm-5.3')
  assert.equal(inputOf(nodes, 'activeLoopCap').props.type, 'number')
  assert.equal(inputOf(nodes, 'activeLoopCap').props.value, '12')
  assert.equal(inputOf(nodes, 'operatorTimeoutMs').props.type, 'number')
  assert.equal(inputOf(nodes, 'operatorTimeoutMs').props.value, '1200000')

  // 覆盖标记与逐字段恢复默认按钮只出现在 user 层覆盖过的字段上。
  assert.deepEqual(
    nodes
      .filter((node) => node.props?.['data-miopiik-overridden'] !== undefined)
      .map((node) => node.props['data-miopiik-overridden'])
      .sort(),
    ['activeLoopCap', 'operatorModel'],
  )
  assert.equal(buttonOf(nodes, '恢复默认') === undefined, false, '覆盖字段应有恢复默认按钮')

  // 未改动时保存不可用（没有脏字段就没有写入）。
  assert.equal(buttonOf(nodes, '保存').props.disabled, true, '无改动时保存应禁用')
  assert.equal(form.calls.mutate.length, 0)

  // 改 activeLoopCap -> 16，保存：一条 set 操作，带读取时的 revision。
  inputOf(nodes, 'activeLoopCap').props.onChange({ target: { value: '16' } })
  nodes = load.walk()
  assert.equal(inputOf(nodes, 'activeLoopCap').props.value, '16')
  assert.equal(buttonOf(nodes, '保存').props.disabled, false)
  buttonOf(nodes, '保存').props.onClick()
  await flush()
  nodes = load.walk()
  assert.deepEqual(
    plain(form.calls.mutate.map((call) => call.ops)),
    [[{ op: 'set', path: ['activeLoopCap'], value: 16 }]],
  )
  assert.equal(form.calls.mutate[0].expectedRevision, 7, '保存应带读取时的 revision 防冲突')

  // 保存被接受后：脏编辑清空、输入框显示已生效值、有状态提示。
  assert.equal(inputOf(nodes, 'activeLoopCap').props.value, '16')
  assert.ok(nodes.some((node) => node.props?.['data-miopiik-form-status'] === '1'))
  assert.equal(buttonOf(nodes, '保存').props.disabled, true, '保存完成后应回到禁用')

  // 改 conversationCompile 与 operatorModel 一起保存：checkbox set false、空文本 unset。
  inputOf(nodes, 'conversationCompile').props.onChange({ target: { checked: false } })
  nodes = load.walk()
  inputOf(nodes, 'operatorModel').props.onChange({ target: { value: '' } })
  nodes = load.walk()
  buttonOf(nodes, '保存').props.onClick()
  await flush()
  nodes = load.walk()
  assert.equal(form.calls.mutate.length, 2)
  assert.deepEqual(plain(form.calls.mutate[1].ops), [
    { op: 'set', path: ['conversationCompile'], value: false },
    { op: 'unset', path: ['operatorModel'] },
  ])
  // 空文本意味着「跟随会话」：输入框为空字符串，不再是假值。
  assert.equal(inputOf(nodes, 'operatorModel').props.value, '')
})

test('重置按钮只撤本地草稿，逐字段「恢复默认」走 unset 写回 Host', async () => {
  const form = makeFakeForm({
    value: { ...FIELD_VALUES, activeLoopCap: 16 },
    user: { activeLoopCap: 16 },
    revision: 3,
    defaults: FIELD_DEFAULTS,
  })
  const load = loadAgentSettings({ form })
  let nodes = load.walk()

  inputOf(nodes, 'operatorTimeoutMs').props.onChange({ target: { value: '900000' } })
  nodes = load.walk()
  inputOf(nodes, 'conversationCompile').props.onChange({ target: { checked: false } })
  nodes = load.walk()

  // 重置：本地草稿撤回，不产生任何 Host 写入。
  buttonOf(nodes, '重置').props.onClick()
  nodes = load.walk()
  assert.equal(form.calls.mutate.length, 0, '重置不该写 Host')
  assert.equal(inputOf(nodes, 'operatorTimeoutMs').props.value, '1200000')
  assert.equal(inputOf(nodes, 'conversationCompile').props.checked, true)

  // 逐字段恢复默认：unset 一条，Host 折回后输入框显示默认值、覆盖标记消失。
  buttonOf(nodes, '恢复默认').props.onClick()
  await flush()
  nodes = load.walk()
  assert.deepEqual(
    plain(form.calls.mutate.map((call) => call.ops)),
    [[{ op: 'unset', path: ['activeLoopCap'] }]],
  )
  assert.equal(form.calls.mutate[0].expectedRevision, 3)
  assert.equal(inputOf(nodes, 'activeLoopCap').props.value, '12')
  assert.equal(
    nodes.some((node) => node.props?.['data-miopiik-overridden'] === 'activeLoopCap'),
    false,
  )
})

test('无 settings 服务或命名空间不可用时不伪造控件', () => {
  // 没有 configForms：插件照常装载，页面给出静态提示而不是假控件。
  const offline = loadAgentSettings({ form: null })
  const offlineNodes = offline.walk()
  assert.ok(offlineNodes.some((node) => node.props?.['data-miopiik-configuration'] === '1'))
  assert.equal(offlineNodes.filter((node) => node.type === 'input').length, 0)
  assert.match(text(offlineNodes), /未提供 DSH 设置服务/u)

  // 命名空间未暴露：status 'unavailable'。
  const unavailable = loadAgentSettings({ form: makeFakeForm({ status: 'unavailable' }) })
  const unavailableNodes = unavailable.walk()
  assert.equal(unavailableNodes.filter((node) => node.type === 'input').length, 0)
  assert.match(text(unavailableNodes), /未暴露 miopiik-dsh 的配置命名空间/u)
})

test('Host 拒写或只读部署下控件禁用，不出现假开关', async () => {
  const refused = makeFakeForm({ value: { ...FIELD_VALUES }, revision: 1, accept: false, defaults: FIELD_DEFAULTS })
  const refusedLoad = loadAgentSettings({ form: refused })
  let nodes = refusedLoad.walk()
  inputOf(nodes, 'activeLoopCap').props.onChange({ target: { value: '20' } })
  nodes = refusedLoad.walk()
  buttonOf(nodes, '保存').props.onClick()
  await flush()
  nodes = refusedLoad.walk()
  // mutate 被调用但返回 false：页面提示拒绝（不伪造成功）。
  assert.equal(refused.calls.mutate.length, 1)
  assert.ok(nodes.some((node) => node.props?.['data-miopiik-form-status'] === '1'))
  assert.match(text(nodes), /保存被拒绝/u)

  // writable: false —— 一切输入与按钮禁用。
  const readonly = makeFakeForm({ value: { ...FIELD_VALUES }, writable: false, defaults: FIELD_DEFAULTS })
  const readonlyLoad = loadAgentSettings({ form: readonly })
  const readonlyNodes = readonlyLoad.walk()
  for (const input of readonlyNodes.filter((node) => node.type === 'input')) {
    assert.equal(input.props.disabled, true, '只读部署下所有控件应禁用')
  }
  assert.equal(buttonOf(readonlyNodes, '保存').props.disabled, true)
  // 旧页伪造的 switch/aria-checked 不应再出现。
  assert.equal(readonlyNodes.filter((node) => node.props?.role === 'switch').length, 0)
  assert.equal(readonlyNodes.filter((node) => node.props?.['aria-checked'] !== undefined).length, 0)
})

test('插件页不使用品牌 Hero、渐变或大型圆角卡片，且只用主题 token', () => {
  const { source } = loadAgentSettings({ form: makeFakeForm() })
  const start = source.indexOf('const MIO_PAGE = {')
  const end = source.indexOf('const zh = {')
  const pageSource = source.slice(start, end)
  assert.ok(start > 0 && end > start)
  assert.doesNotMatch(pageSource, /linear-gradient/u)
  assert.doesNotMatch(pageSource, /borderRadius: 1[0-9]/u, '不应再有大圆角卡片')
  assert.match(pageSource, /var\(--dsw-alias-/u, '样式应使用 DSH 主题 token')
  assert.doesNotMatch(pageSource, /#[0-9a-fA-F]{3,6}/u, '不应写死颜色')
})
