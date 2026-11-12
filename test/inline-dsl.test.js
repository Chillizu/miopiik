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
