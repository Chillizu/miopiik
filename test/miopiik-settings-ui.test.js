import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'

const root = new URL('../', import.meta.url)
const clientPath = new URL('client.js', root)

// 两个面：插件页只做说明，设置入口在「设置 → 内置插件」。
const SLOT_NAMES = ['plugins.bundle.config', 'settings.plugins.tab']

function loadAgentSettings() {
  const source = readFileSync(clientPath, 'utf8')
  let module
  const sandbox = { console }
  sandbox.window = sandbox
  sandbox.__ModuleLoader__ = { load(value) { module = value } }
  createContext(sandbox)
  new Script(source, { filename: 'client.js' }).runInContext(sandbox, { timeout: 3000 })
  assert.equal(module.id, 'miopiik-dsh')
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
  }
  const plugin = module.factory((name) => {
    if (name === 'react') return React
    // Primitive UI is optional; the page must stay renderable without it.
    throw new Error('unexpected dependency: ' + name)
  })
  const slots = []
  plugin.apply({
    effect() {},
    locale: { bind() { return (key) => key } },
    slots: {
      inject(name, callback) {
        // 其它插槽（conversation.view 等）在本页测试里不关心。
        if (SLOT_NAMES.includes(name)) callback()
      },
      register(meta, render) { slots.push({ meta, render }); return () => {} },
    },
    inject() {},
  })
  return { plugin, slots, source }
}

/** Render host nodes recursively; function components receive their props. */
function render(node) {
  if (node === null || node === undefined || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(render)
  if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }))
  return [node, ...(node.children ?? []).flatMap(render)]
}

function slotBy(slots, name) {
  const entry = slots.find((slot) => slot.meta.name === name)
  assert.ok(entry !== undefined, 'missing slot: ' + name)
  return entry
}

function page(slots, props = { view: 'page' }) {
  return render(slotBy(slots, 'plugins.bundle.config').render(props))
}

function settingsPage(slots) {
  return render(slotBy(slots, 'settings.plugins.tab').render({}))
}

function text(nodes) {
  return nodes.flatMap((node) => (node.children ?? []).filter((child) => typeof child === 'string')).join(' ')
}

test('MiOpIIk Agent 把说明留在插件页，把配置放进「设置 → 内置插件」', () => {
  const { plugin, slots, source } = loadAgentSettings()
  assert.ok(plugin.inject.includes('slots'))
  assert.equal(slots.length, 2)
  const bundle = slotBy(slots, 'plugins.bundle.config')
  assert.equal(bundle.meta.key, 'miopiik-dsh')
  const tab = slotBy(slots, 'settings.plugins.tab')
  assert.equal(tab.meta.id, 'miopiik-dsh')
  assert.equal(tab.meta.order, 30)
  assert.equal(tab.meta.label(), 'settings.tab')
  assert.match(source, /'settings\.tab': 'MiOpIIk Agent'/u)
  assert.doesNotMatch(source, /ctx\.slots\.inject\('settings\.section'/u)
  assert.doesNotMatch(source, /globalThis\.__miopiikMarkdownEmbeds\s*=/u)
})

test('插件页只做介绍：覆盖三层架构、版本与和 IUI 的独立关系，不再藏配置', () => {
  const { slots } = loadAgentSettings()
  const packageVersion = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version
  const nodes = page(slots)
  const tree = nodes[0]
  assert.equal(tree.props['data-miopiik-settings'], '1')
  assert.equal(nodes.filter((node) => node.props?.role === 'tab').length, 0, '插件页不该再有二级页签')
  assert.ok(nodes.some((node) => node.props?.['data-miopiik-overview'] === '1'))
  assert.equal(nodes.some((node) => node.props?.['data-miopiik-configuration'] === '1'), false)
  assert.match(text(nodes), /设置 → 内置插件 → MiOpIIk Agent/u, '插件页要指出配置入口')

  const architecture = nodes.find((node) => node.props?.['data-miopiik-architecture'] === '1')
  assert.ok(architecture)
  const architectureText = render(architecture).map((node) => node.children ?? []).flat().filter((child) => typeof child === 'string').join(' ')
  for (const name of ['Mind', 'Ink', 'Operator']) assert.match(architectureText, new RegExp(name, 'u'))
  const body = text(nodes)
  assert.match(body, new RegExp('v?' + packageVersion.replaceAll('.', '\\.'), 'u'), '介绍页应显示版本')
  assert.match(body, /独立插件/u)
  assert.ok(body.includes('miopiik-iui'), '介绍页应说明与 miopiik-iui 的独立关系')
  assert.match(body, /Mind/iu)
})

test('设置页只读地列出 Host 参数默认值、分组与有效 YAML 示例，不伪造开关', () => {
  const { slots } = loadAgentSettings()
  const nodes = settingsPage(slots)
  assert.ok(nodes.some((node) => node.props?.['data-miopiik-configuration'] === '1'))
  assert.equal(nodes.some((node) => node.props?.['data-miopiik-overview'] === '1'), false)

  const groups = nodes.filter((node) => node.props?.['data-miopiik-group'])
  assert.deepEqual(groups.map((group) => group.props['data-miopiik-group']), ['mind', 'ink', 'operator'])
  const defaults = nodes.filter((node) => node.props?.['data-miopiik-default'])
  assert.equal(defaults.length, 14, '14 个 Host 参数都应列出默认值')
  assert.equal(defaults.find((node) => node.props['data-miopiik-default'] === 'stateRoot').children[0], '.dsh/miopiik')
  assert.equal(defaults.find((node) => node.props['data-miopiik-default'] === 'conversationCompile').children[0], 'true')
  assert.equal(defaults.find((node) => node.props['data-miopiik-default'] === 'inkModel').children[0], '跟随会话')

  const body = text(nodes)
  assert.match(body, /内置默认值，不是当前实际运行值/u, '必须说明默认值不等于当前值')
  assert.match(body, /cordis\.patch\.yml/u)
  assert.match(body, /整体替换该条目的 config/u)

  const example = nodes.find((node) => node.props?.['data-miopiik-config-example'] === '1')
  assert.ok(example)
  assert.match(example.children[0], /^# ~\/\.dsh\/profiles\/<profile>\/cordis\.patch\.yml\n- id: miopiik-dsh\n  config:\n/u)
  assert.match(example.children[0], /activeLoopCap: 12/u)
  assert.ok(nodes.some((node) => node.props?.['data-miopiik-copy-status'] === '1'))

  // Read-only reference: no editable inputs and no switch pretending to be live config.
  assert.equal(nodes.filter((node) => node.type === 'input').length, 0)
  assert.equal(nodes.filter((node) => node.props?.role === 'switch').length, 0)
  assert.equal(nodes.filter((node) => node.props?.['aria-checked'] !== undefined).length, 0)
})

test('设置页不使用品牌 Hero、渐变或大型圆角卡片，且只用主题 token', () => {
  const { source, slots } = loadAgentSettings()
  const start = source.indexOf('const MIO_PAGE = {')
  const end = source.indexOf('const zh = {')
  const pageSource = source.slice(start, end)
  assert.ok(start > 0 && end > start)
  assert.doesNotMatch(pageSource, /linear-gradient/u)
  assert.doesNotMatch(pageSource, /borderRadius: 1[0-9]/u, '不应再有大圆角卡片')
  assert.match(pageSource, /var\(--dsw-alias-/u, '样式应使用 DSH 主题 token')
  assert.doesNotMatch(pageSource, /#[0-9a-fA-F]{3,6}/u, '不应写死颜色')

  const nodes = [...page(slots), ...settingsPage(slots)]
  assert.ok(nodes.length > 0)
})
