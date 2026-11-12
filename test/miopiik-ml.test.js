import test from 'node:test'
import assert from 'node:assert/strict'

import { validateAst } from '../miopiik-dsh/shared/iui-ast.js'
import { parseMiopiikMl } from '../miopiik-dsh/shared/miopiik-ml.js'

const ML = `<ui title="周活跃" fallback="近7天活跃45次">
  <state>{"range":{"current":45,"prev":31,"series":[["一",12]]}}</state>
  <column gap="10">
    <text>切换范围只改本地状态。</text>
    <row gap="12">
      <metric label="当前" value="$state.range.current" unit="次"/>
      <metric label="上一" value="$state.range.prev" unit="次"/>
    </row>
    <segmented label="范围" bind="$state.range" options='[{"label":"近7天","value":{"current":45}}]'/>
    <chart kind="bar" series="$state.range.series" source="示例"/>
  </column>
</ui>`

test('miopiik-ml：嵌套结构编译成 AST 并通过唯一校验器', () => {
  const parsed = parseMiopiikMl(ML)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.doc.title, '周活跃')
  assert.equal(parsed.doc.root.type, 'column')
  const [text, row] = parsed.doc.root.children
  assert.equal(text.type, 'text')
  assert.equal(text.props.text, '切换范围只改本地状态。')
  assert.equal(row.type, 'row')
  assert.equal(row.children[0].props.value, '$state.range.current')

  const checked = validateAst(parsed.doc)
  assert.equal(checked.ok, true)
  assert.equal(checked.degraded, 0)
  assert.deepEqual(Object.keys(checked.ast.state), ['range'])
})

test('miopiik-ml：未知标签/脚本只降级子树，兄弟与父布局保留', () => {
  const parsed = parseMiopiikMl('<ui fallback="f"><column><text>保留我</text><script>alert(1)</script><metric label="a" value="1"/></column></ui>')
  assert.equal(parsed.ok, true)
  const types = parsed.doc.root.children.map((node) => node.type)
  assert.deepEqual(types, ['text', 'text', 'metric'])
  assert.match(parsed.degraded.join(''), /script/)
  assert.equal(parsed.doc.root.children[0].props.text, '保留我')
  // script 内容绝不会变成组件或可执行内容
  assert.equal(JSON.stringify(parsed.doc).includes('alert'), false)
})

test('miopiik-ml：半截/未闭合保留已写出的文本，不整段丢失', () => {
  const parsed = parseMiopiikMl('<ui fallback="半截"><column><text>已经写了一半')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.doc.root.type, 'text')
  assert.equal(parsed.doc.root.props.text, '已经写了一半')
  assert.match(parsed.degraded.join(''), /没有闭合/)
})

test('miopiik-ml：card/grid/table 是通用组合原语，不是预设卡片', () => {
  const parsed = parseMiopiikMl(`<ui fallback="f">
    <grid columns="2" gap="12">
      <card title="左"><metric label="A" value="1"/><text>说明</text></card>
      <card title="右"><table columns='["项","值"]' rows='[["x",1]]' caption="口径"/></card>
    </grid>
  </ui>`)
  assert.equal(parsed.ok, true)
  const checked = validateAst(parsed.doc)
  assert.equal(checked.ok, true)
  const grid = checked.ast.root
  assert.equal(grid.type, 'grid')
  assert.equal(grid.children.length, 2)
  assert.equal(grid.children[0].type, 'card')
  assert.equal(grid.children[1].children[0].type, 'table')
})

test('miopiik-ml：没有 <ui> 根 / 空内容时明确拒绝，让调用方降级为文本', () => {
  assert.equal(parseMiopiikMl('随便一段没有标签的文字').ok, false)
  assert.equal(parseMiopiikMl('<ui fallback="f"></ui>').ok, false)
})

test('miopiik-ml：id 稳定唯一，重复解析结果一致（回放/状态不漂移）', () => {
  const a = parseMiopiikMl(ML)
  const b = parseMiopiikMl(ML)
  assert.deepEqual(a.doc, b.doc)
  const ids = []
  const walk = (node) => {
    ids.push(node.id)
    for (const child of node.children) walk(child)
  }
  walk(a.doc.root)
  assert.equal(new Set(ids).size, ids.length)
})
