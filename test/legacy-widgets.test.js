import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

import { validateAst } from '../miopiik-iui/shared/iui-ast.js'
import { adoptLegacySpec } from '../miopiik-iui/shared/legacy-widgets.js'
import { splitTrustedMarkdown } from '../miopiik-iui/shared/markdown-segments.js'

const readJson = (name) => JSON.parse(readFileSync(new URL(`./fixtures/legacy/${name}`, import.meta.url), 'utf8'))
const readText = (name) => readFileSync(new URL(`./fixtures/legacy/${name}`, import.meta.url), 'utf8')

test('历史兼容：真实旧会话的 dataset+chart spec 映射为 chart AST 并通过校验', () => {
  const spec = readJson('dataset-chart.json')
  const adopted = adoptLegacySpec(spec)
  assert.equal(adopted.ok, true)
  assert.equal(adopted.doc.root.type, 'chart')
  assert.equal(adopted.doc.root.props.kind, 'line')
  assert.equal(adopted.doc.root.props.series.length, spec.props.rows.length)
  assert.equal(adopted.doc.root.props.series[0][0], '第1周')
  const checked = validateAst(adopted.doc)
  assert.equal(checked.ok, true)
  assert.equal(checked.degraded, 0)
})

test('历史兼容：对象列描述的旧 dataset 映射为 table，不丢数据', () => {
  const spec = readJson('dataset-object-columns.json')
  const adopted = adoptLegacySpec(spec)
  assert.equal(adopted.ok, true)
  assert.equal(adopted.doc.root.type, 'table')
  const columns = adopted.doc.root.props.columns
  const rows = adopted.doc.root.props.rows
  assert.ok(Array.isArray(columns) && columns.length >= 2)
  assert.equal(rows.length, spec.props.rows.length)
  assert.equal(JSON.stringify(rows).includes('[object Object]'), false)
  assert.equal(validateAst(adopted.doc).ok, true)
})

test('历史兼容：无法映射的旧 widget（mermaid）失败并保留 fallback，由渲染器降级文本', () => {
  const adopted = adoptLegacySpec({ widget: 'mermaid', fallback: '旧图无法还原' })
  assert.equal(adopted.ok, false)
  assert.equal(adopted.fallback, '旧图无法还原')
  assert.match(adopted.errors.join(''), /mermaid/u)
})

test('历史兼容：layout 嵌套递归映射，且产出仍受 validateAst 约束', () => {
  const adopted = adoptLegacySpec({
    widget: 'layout',
    props: {
      direction: 'row',
      children: [
        { widget: 'text', props: { paragraphs: ['左'] }, fallback: 'l' },
        { widget: 'dataset', props: { columns: ['项', '值'], rows: [['a', 1]] }, fallback: 'r' },
      ],
    },
    fallback: 'f',
  })
  assert.equal(adopted.ok, true)
  assert.equal(adopted.doc.root.type, 'row')
  assert.equal(adopted.doc.root.children.length, 2)
  assert.equal(validateAst(adopted.doc).ok, true)
})

test('切分：```ink-view 围栏被识别为 block 且 lang 正确，前后文字不丢', () => {
  const parts = splitTrustedMarkdown(readText('prose-with-ink-view.md'))
  assert.deepEqual(parts.map((part) => part.kind), ['text', 'block', 'text'])
  assert.equal(parts[1].lang, 'ink-view')
  assert.match(parts[1].raw, /"widget"/u)
  assert.equal(parts[0].text.includes('历史消息前缀'), true)
  assert.equal(parts[2].text.includes('历史消息后缀'), true)
})

test('切分：```iui 仍走新主路径', () => {
  const parts = splitTrustedMarkdown('前\n```iui\n<ui fallback="f"><text>hi</text></ui>\n```\n后')
  assert.equal(parts[1].lang, 'iui')
})

test('旧入口不复活：Agent 包不再有旧 renderer/DSL/spec 校验器，也不再教旧协议', () => {
  const root = new URL('..', import.meta.url).pathname
  for (const gone of ['miopiik-dsh/shared', 'miopiik-dsh/host/widgets.js', 'miopiik-dsh/host/ui-dsl.js']) {
    assert.equal(existsSync(`${root}${gone}`), false, `${gone} 应已被移除`)
  }
  const prompt = readFileSync(new URL('../miopiik-dsh/host/prompt.js', import.meta.url), 'utf8')
  assert.doesNotMatch(prompt, /ink-view|ink_view|ink_chart|七种 widget|widget 只能从/u, '提示词仍在教旧展示协议')
  const tools = readFileSync(new URL('../miopiik-dsh/host/tools.js', import.meta.url), 'utf8')
  assert.doesNotMatch(tools, /name:\s*'ink_view'|name:\s*'ink_chart'|ink-view/u, '旧展示工具又注册回来了')
  const client = readFileSync(new URL('../miopiik-iui/client.js', import.meta.url), 'utf8')
  assert.match(client, /LEGACY_WIDGETS/u, '历史只读 adapter 未进入客户端产物')
  assert.match(client, /format: 'legacy'/u)
})
