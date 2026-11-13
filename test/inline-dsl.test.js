import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { comparePayloadCost, compileInlineDsl } from '../miopiik-dsh/host/ui-dsl.js'

test('DSL：数据块编译成通过的 AST，与正文混排保序', () => {
  const segments = compileInlineDsl(`先看结论。\n\n::card title="预算" source="git log"\nchart bar\n本周 3\n下周 5\n::end\n\n之后继续。`)
  assert.equal(segments.length, 3)
  assert.equal(segments[0].kind, 'text')
  assert.equal(segments[1].kind, 'ui')
  assert.equal(segments[1].spec.widget, 'dataset')
  assert.equal(segments[1].spec.props.rows.length, 2)
  assert.equal(segments[2].kind, 'text')
})

test('DSL：非法内容降级为文本，绝不进渲染', () => {
  const bad = compileInlineDsl('::card title="x"\nchart bar\n本周 abc\n::end')
  assert.equal(bad.every((segment) => segment.kind === 'text'), true)
  const unknown = compileInlineDsl('::mermaid\nx\n::end')
  assert.equal(unknown.every((segment) => segment.kind === 'text'), true)
})

test('DSL：同一份内容的字符成本低于 JSON（粗代理）', () => {
  const specs = [
    { widget: 'dataset', title: '每周提交', props: { chart: true, columns: [{ label: '周' }, { label: '提交' }], rows: [['本周', 12], ['下周', 9]], source: 'git log' }, fallback: 'x' },
    { widget: 'dataset', title: '测试条数', props: { chart: 'line', columns: [{ label: '阶段' }, { label: '条数' }], rows: [['一', 140], ['二', 154]], source: 'node --test' }, fallback: 'y' },
  ]
  const cost = comparePayloadCost(specs)
  assert.ok(cost.ratio < 0.6, `DSL 应明显更短，实际 ratio=${cost.ratio}（json=${cost.json}, dsl=${cost.dsl}）`)
})

test('旧 DSL 预览入口从 Agent 页面退场；独立 IUI 配置提供真实预览', async () => {
  const { readFileSync } = await import('node:fs')
  const agent = readFileSync(new URL('../miopiik-dsh/client.js', import.meta.url), 'utf8')
  const standalone = readFileSync(new URL('../miopiik-iui/client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(agent, /function DslPreview|data-dsl-preview|function WidgetCanvas|settings.inlineBody/u)
  assert.match(standalone, /data-iui-plugin-settings/u)
  assert.match(standalone, /data-iui-settings-preview/u)
  assert.match(standalone, /plugins.bundle.config/u)
})

test('半截/未闭合块与坏数值都只降级为文本', () => {
  const partial = compileInlineDsl('::card title="半截"\nchart bar\n周一 1\n')
  assert.equal(partial.every((segment) => segment.kind === 'text'), true)
  const unterminated = compileInlineDsl('::card title="x"\nchart bar\n周一 abc\n::end')
  assert.equal(unterminated.every((segment) => segment.kind === 'text'), true)
})

test('DSL 编译结果必须能过同一套 validateSpec（未知标签/超预算被拒并降级）', () => {
  const unknown = compileInlineDsl('::mermaid\ngraph TD\n::end')
  assert.equal(unknown.every((segment) => segment.kind === 'text'), true)
  const tooMany = compileInlineDsl(['::card title="超行"', 'chart bar', ...Array.from({ length: 210 }, (_, i) => `项${i} ${i}`), '::end'].join('\n'))
  assert.equal(tooMany.every((segment) => segment.kind === 'text'), true)
})
