import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { tableMatrix, validateAst } from '../miopiik-dsh/shared/iui-ast.js'
import { parseMiopiikMl } from '../miopiik-dsh/shared/miopiik-ml.js'

const read = (name) => readFileSync(new URL(`./fixtures/gallery/${name}.iui`, import.meta.url), 'utf8')

const CASES = [
  ['zone1-base', { blocks: ['paragraph', 'row', 'callout', 'divider', 'progress', 'empty'] }],
  ['zone2-data', { blocks: ['row', 'grid', 'card', 'chart', 'table', 'progress'] }],
  ['zone3-interactive', { blocks: ['paragraph', 'segmented', 'row', 'card', 'callout'] }],
]

for (const [name, expect] of CASES) {
  test(`真实画廊样本 ${name}：解析与校验零降级`, () => {
    const parsed = parseMiopiikMl(read(name))
    assert.equal(parsed.ok, true, `解析失败：${parsed.errors?.join('；')}`)
    assert.deepEqual(parsed.degraded, [], `解析阶段仍有降级：${parsed.degraded.join('；')}`)
    const checked = validateAst(parsed.doc)
    assert.equal(checked.ok, true, `校验失败：${checked.errors?.join('；')}`)
    assert.equal(checked.degraded, 0, 'AST 阶段不应再有降级')
    const types = new Set()
    const walk = (node) => {
      types.add(node.type)
      for (const child of node.children ?? []) walk(child)
    }
    walk(checked.ast.root)
    for (const expected of expect.blocks) assert.ok(types.has(expected), `缺少组件 ${expected}`)
  })
}

test('真实画廊样本 zone2：对象行表格归一为二维表，不出现 [object Object]', () => {
  const parsed = parseMiopiikMl(read('zone2-data'))
  const checked = validateAst(parsed.doc)
  let table = null
  const walk = (node) => {
    if (node.type === 'table') table = node
    for (const child of node.children ?? []) walk(child)
  }
  walk(checked.ast.root)
  assert.ok(table !== null, '样本里应有表格')
  const matrix = tableMatrix(table.props)
  assert.deepEqual(matrix.columns, ['渠道', '会话', '渲染成功率', '状态'])
  assert.equal(matrix.rows.length, 4)
  assert.equal(matrix.rows[0][0], 'Web 客户端')
  assert.equal(JSON.stringify(matrix.rows).includes('[object Object]'), false)
})

test('真实画廊样本 zone3：state 初始化与绑定路径可解析（不再出现 — 与空图）', () => {
  const parsed = parseMiopiikMl(read('zone3-interactive'))
  const checked = validateAst(parsed.doc)
  assert.ok(checked.ast.state.range, '<state name=...> 必须初始化到 state')
  assert.equal(checked.ast.state.range.current.value, '12,480')

  const find = (type, predicate = () => true) => {
    let hit = null
    const walk = (node) => {
      if (hit !== null) return
      if (node.type === type && predicate(node)) {
        hit = node
        return
      }
      for (const child of node.children ?? []) walk(child)
    }
    walk(checked.ast.root)
    return hit
  }
  const metric = find('metric', (node) => String(node.props.value ?? '').startsWith('$state.'))
  assert.equal(metric.props.value, '$state.range.current.value')
  assert.equal(metric.props.delta, '$state.range.current.delta')
  const segmented = find('segmented')
  assert.equal(segmented.props.options.length, 2)
  assert.equal(segmented.props.options[0].value.current.value, '12,480')
})
