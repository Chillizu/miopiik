import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'
import { apply as hostApply, IUI_CHARTER } from '../miopiik-iui/index.js'
import { parseMiopiikMl } from '../miopiik-iui/shared/miopiik-ml.js'
import { validateAst } from '../miopiik-iui/shared/iui-ast.js'

const path = new URL('../miopiik-iui/', import.meta.url)
const text = (file) => readFileSync(new URL(file, path), 'utf8')

function loadStandalonePlugin() {
  let loaded
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useMemo(value) { return value() },
    useState(value) { return [value, () => {}] },
    useEffect() {},
  }
  const sandbox = { console }
  sandbox.window = sandbox
  sandbox.__ModuleLoader__ = { load(value) { loaded = value } }
  createContext(sandbox)
  new Script(text('client.js'), { filename: 'miopiik-iui/client.js' }).runInContext(sandbox, { timeout: 3000 })
  assert.equal(loaded.id, 'miopiik-iui')
  const plugin = loaded.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected dependency: ' + name)
  })
  let dispose = null
  plugin.apply({ effect(callback) { dispose = callback() } })
  return { sandbox, registry: sandbox.__miopiikMarkdownEmbeds, dispose }
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

test('无受信标记的 Markdown 不切分，行内标记无执行能力', () => {
  const { registry } = loadStandalonePlugin()
  assert.equal(registry.segments('纯 Markdown 与 **加粗**').map((x) => x.kind).join(','), 'text')
  const badge = registry.renderInline({ type: 'badge', props: { tone: 'success', text: '好了' } })
  assert.equal(badge.type, 'span')
  assert.equal(badge.props['data-iui-badge'], 'success')
})
