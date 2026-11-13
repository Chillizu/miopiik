import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'
import { apply as hostApply, IUI_CHARTER } from '../miopiik-iui/index.js'
import { parseMiopiikMl } from '../miopiik-iui/shared/miopiik-ml.js'
import { validateAst } from '../miopiik-iui/shared/iui-ast.js'

const path = new URL('../miopiik-iui/', import.meta.url)
const text = (file) => readFileSync(new URL(file, path), 'utf8')

function loadStandalonePlugin({ preference = null } = {}) {
  let loaded
  let copied = ''
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useMemo(value) { return value() },
    useState(value) { return [typeof value === 'function' ? value() : value, () => {}] },
    useEffect() {},
    useCallback(value) { return value },
  }
  // The page prefers the official primitives; the stub keeps the same contract.
  const primitives = {
    SegmentedTabs({ items, value, onChange }) {
      return React.createElement('div', { role: 'tablist' }, items.map((item) => React.createElement(
        'button',
        { key: item.value, role: 'tab', 'aria-selected': value === item.value, onClick: () => onChange(item.value) },
        item.label,
      )))
    },
    Switch({ checked, onChange, label }) {
      return React.createElement('button', {
        role: 'switch', 'aria-checked': checked, 'aria-label': label,
        onClick: () => onChange(!checked),
      })
    },
    Button({ onClick, children }) { return React.createElement('button', { onClick }, children) },
  }
  const storage = new Map(preference === null ? [] : [['miopiik.markdownEmbeds', preference]])
  let reloads = 0
  const sandbox = {
    console,
    localStorage: { getItem(key) { return storage.get(key) ?? null }, setItem(key, value) { storage.set(key, value) } },
    location: { reload() { reloads += 1 } },
    navigator: { clipboard: { writeText(value) { copied = value; return Promise.resolve() } } },
  }
  sandbox.window = sandbox
  sandbox.__ModuleLoader__ = { load(value) { loaded = value } }
  createContext(sandbox)
  new Script(text('client.js'), { filename: 'miopiik-iui/client.js' }).runInContext(sandbox, { timeout: 3000 })
  assert.equal(loaded.id, 'miopiik-iui')
  const plugin = loaded.factory((name) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error('unexpected dependency: ' + name)
  })
  assert.equal(Array.from(plugin.inject).join(','), 'slots', 'DSH slot API requires explicit Cordis injection')
  let dispose = null
  const slots = []
  plugin.apply({
    effect(callback) { dispose = callback() },
    slots: { inject(name, register) { assert.equal(name, 'plugins.bundle.config'); register() }, register(metadata, render) { slots.push({ metadata, render }); return () => {} } },
  })
  return { sandbox, registry: sandbox.__miopiikMarkdownEmbeds, dispose, slots, storage, getReloads: () => reloads, getCopied: () => copied }
}

/** Render host nodes recursively; function components receive their props. */
function render(node) {
  if (node === null || node === undefined || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(render)
  if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }))
  return [node, ...(node.children ?? []).flatMap(render)]
}

function renderPage(slots, props = { view: 'page' }) {
  return render(slots[0].render(props))
}

test('独立包不依赖 MiOpIIk Agent，也不注册旧工具', () => {
  const manifest = JSON.parse(text('package.json'))
  assert.equal(manifest.name, 'miopiik-iui')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.exports['./client'])
  assert.doesNotMatch(text('index.js'), /miopiik-dsh|ink_view|ink_chart/u)
  assert.doesNotMatch(text('client.js'), /ink_view|ink_chart|miopiikBackstage/u)
  assert.doesNotMatch(text('../miopiik-dsh/host/tools.js'), /name:\s*'ink_view'|name:\s*'ink_chart'/u)
  assert.doesNotMatch(text('../miopiik-dsh/client.js'), /globalThis\.__miopiikMarkdownEmbeds\s*=/u)
  assert.doesNotMatch(text('../miopiik-dsh/client.js'), /key: 'assistant-step', priority/u)
})

test('Host 输出约定独立注入，不占用工具面', () => {
  const sections = []
  hostApply({
    inject(names, callback) {
      assert.deepEqual(names, ['systemPrompt'])
      callback({ systemPrompt: { section(value) { sections.push(value) } } })
    },
  })
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'miopiik-iui:render-contract')
  assert.match(sections[0].text, /miopiik-ml/u)
  assert.match(IUI_CHARTER, /优先普通 Markdown/u)
})

test('客户端在没有 Mind/Ink/Operator 时可加载、渲染并注销', () => {
  const { sandbox, registry, dispose } = loadStandalonePlugin()
  assert.equal(typeof registry.segments, 'function')
  assert.equal(typeof registry.renderBlock, 'function')
  assert.equal(typeof registry.renderInline, 'function')
  const fence = String.fromCharCode(96).repeat(3)
  const segments = registry.segments('状态 {{badge:success:完成}}\n' + fence + 'iui\n<ui><metric label="次数" value="12"/></ui>\n' + fence)
  assert.equal(segments.filter((x) => x.kind === 'inline').length, 1)
  assert.equal(segments.filter((x) => x.kind === 'block').length, 1)
  const sample = '<ui title="演示" fallback="12次"><metric label="次数" value="12" unit="次"/></ui>'
  const parsed = parseMiopiikMl(sample)
  assert.equal(validateAst(parsed.doc).ok, true)
  const element = registry.renderBlock(sample)
  assert.equal(typeof element.type, 'function')
  const output = element.type(element.props)
  assert.equal(output.props['data-iui-output'], 'ok')
  assert.equal(output.props['data-iui-degraded'], '0')
  dispose()
  assert.equal(sandbox.__miopiikMarkdownEmbeds, undefined)
})

test('插件页分为介绍与配置，介绍用真实渲染器预览并说明兼容边界', () => {
  const { slots } = loadStandalonePlugin()
  const nodes = renderPage(slots)
  assert.ok(nodes.some((node) => node.props?.['data-iui-plugin-settings'] === '1'))
  const tabs = nodes.filter((node) => node.props?.role === 'tab')
  assert.deepEqual(tabs.map((tab) => tab.children[0]), ['介绍', '配置'])
  assert.ok(nodes.some((node) => node.props?.['data-iui-overview'] === '1'))
  assert.equal(nodes.some((node) => node.props?.['data-iui-configuration'] === '1'), false)
  assert.equal(nodes.find((node) => node.props?.['data-iui-settings-preview'])?.props['data-iui-settings-preview'], 'live')
  assert.match(nodes.flatMap((node) => node.children ?? []).filter((child) => typeof child === 'string').join(' '), /独立插件/u)
  const text = nodes.flatMap((node) => node.children ?? []).filter((child) => typeof child === 'string').join(' ')
  assert.match(text, /兼容性与边界/u)
  assert.match(text, /MiOpIIk Agent/u)
  assert.match(text, /无任意 HTML/u)
})

test('配置页只有一个真实的浏览器渲染开关，并提供诊断与可复制示例', async () => {
  const { slots, storage, getReloads, getCopied } = loadStandalonePlugin()
  const nodes = renderPage(slots, { view: 'page', initialTab: 'configuration' })
  assert.ok(nodes.some((node) => node.props?.['data-iui-configuration'] === '1'))
  assert.equal(nodes.some((node) => node.props?.['data-iui-overview'] === '1'), false)
  const switches = nodes.filter((node) => node.props?.role === 'switch')
  assert.equal(switches.length, 1, '只应有一个真实开关')
  assert.equal(switches[0].props['aria-checked'], true)
  assert.equal(nodes.filter((node) => node.type === 'input').length, 0)
  assert.ok(nodes.some((node) => node.props?.['data-iui-registry-state'] === 'ready'))
  assert.ok(nodes.some((node) => node.props?.['data-iui-preview-source'] === '1'))
  const body = nodes.flatMap((node) => node.children ?? []).filter((child) => typeof child === 'string').join(' ')
  assert.match(body, /仅作用于当前浏览器/u)
  assert.match(body, /不会改写任何历史数据/u)
  assert.match(body, /实验性 DSH Chat Markdown 补丁|未检测到补丁/u)

  switches[0].props.onClick()
  assert.equal(storage.get('miopiik.markdownEmbeds'), '0')
  assert.equal(getReloads(), 1)

  const copy = nodes.find((node) => node.type === 'button' && (node.children ?? []).flat(Infinity).includes('复制示例'))
  assert.ok(copy)
  await copy.props.onClick()
  assert.match(getCopied(), /^```iui\n<ui /u)

  const disabled = loadStandalonePlugin({ preference: '0' })
  const disabledNodes = renderPage(disabled.slots, { view: 'page', initialTab: 'configuration' })
  const disabledSwitch = disabledNodes.find((node) => node.props?.role === 'switch')
  assert.equal(disabledSwitch.props['aria-checked'], false)
  disabledSwitch.props.onClick()
  assert.equal(disabled.storage.get('miopiik.markdownEmbeds'), '1')
  assert.equal(disabled.getReloads(), 1)
})

test('无受信标记的 Markdown 不切分，行内标记无执行能力', () => {
  const { registry } = loadStandalonePlugin()
  assert.equal(registry.segments('纯 Markdown 与 **加粗**').map((x) => x.kind).join(','), 'text')
  const badge = registry.renderInline({ type: 'badge', props: { tone: 'success', text: '好了' } })
  assert.equal(badge.type, 'span')
  assert.equal(badge.props['data-iui-badge'], 'success')
})
