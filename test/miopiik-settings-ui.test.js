import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'

function loadAgentSettings() {
  const source = readFileSync(new URL('../miopiik-dsh/client.js', import.meta.url), 'utf8')
  let module
  const sandbox = { console }
  sandbox.window = sandbox
  sandbox.__ModuleLoader__ = { load(value) { module = value } }
  createContext(sandbox)
  new Script(source, { filename: 'miopiik-dsh/client.js' }).runInContext(sandbox, { timeout: 3000 })
  assert.equal(module.id, 'miopiik-dsh')
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
  }
  const plugin = module.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected dependency: ' + name)
  })
  const slots = []
  plugin.apply({
    effect() {},
    locale: { bind() { return (key) => key } },
    slots: {
      inject(name, callback) { if (name === 'plugins.bundle.config') callback() },
      register(meta, render) { slots.push({ meta, render }); return () => {} },
    },
    inject() {},
  })
  return { plugin, slots }
}
function flatten(node) {
  if (node === null || typeof node !== 'object') return []
  return [node, ...(node.children ?? []).flatMap(flatten)]
}
test('MiOpIIk Agent 独立注册 DSH 原生插件页，不和 IUI 混用或占用通用设置', () => {
  const { plugin, slots } = loadAgentSettings()
  assert.ok(plugin.inject.includes('slots'))
  assert.equal(slots.length, 1)
  assert.equal(slots[0].meta.name, 'plugins.bundle.config')
  assert.equal(slots[0].meta.key, 'miopiik-dsh')
  const agentSource = readFileSync(new URL('../miopiik-dsh/client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(agentSource, /ctx\.slots\.inject\('settings\.section'/u)
  assert.doesNotMatch(agentSource, /globalThis\.__miopiikMarkdownEmbeds\s*=/u)
})
test('设置页有三层职责、按默认值分组，不伪造实时配置状态', () => {
  const { slots } = loadAgentSettings()
  const element = slots[0].render({view: 'page'})
  const tree = element.type(element.props)
  const nodes = flatten(tree)
  assert.equal(tree.props['data-miopiik-settings'], '1')
  assert.ok(nodes.some((n) => n?.props?.['data-miopiik-architecture'] === '1'))
  assert.equal(nodes.filter((n) => n?.props?.['data-miopiik-group']).length, 3)
  assert.equal(nodes.find((n) => n?.props?.['data-miopiik-group'] === 'ink')?.props?.['aria-expanded'], true)
  assert.ok(nodes.some((n) => n?.props?.['data-miopiik-default'] === 'stateRoot'))
  const text = nodes.flatMap((n) => n?.children ?? []).filter((v) => typeof v === 'string').join(' ')
  assert.match(text, /内置默认值，不是实际运行配置/u)
  assert.match(text, /文件为准/u)
  assert.doesNotMatch(text, /服务正常运行|所有任务正常/u)
  const toggle = nodes.find((n) => n?.props?.['data-miopiik-example-toggle'] === '1')
  assert.equal(toggle.props['aria-expanded'], false)
  assert.equal(typeof toggle.props.onClick, 'function')
})
