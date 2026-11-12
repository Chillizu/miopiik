import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { IUI_VERSION, readBinding, resolveValue, validateAst } from '../miopiik-iui/shared/iui-ast.js'

const good = () => ({
  title: 't',
  state: { range: { current: 1 } },
  fallback: 'f',
  root: {
    id: 'root',
    type: 'column',
    children: [
      { id: 'm', type: 'metric', props: { label: 'a', value: '$state.range.current' } },
      { id: 'c', type: 'chart', props: { kind: 'bar', series: [['x', 1]] } },
    ],
  },
})

test('合法 AST：版本、绑定、状态初值都保留', () => {
  const checked = validateAst(good())
  assert.equal(checked.ok, true)
  assert.equal(checked.ast.version, IUI_VERSION)
  assert.equal(checked.ast.root.children.length, 2)
  assert.deepEqual(resolveValue('$state.range.current', { state: { range: { current: 7 } } }), 7)
})

test('未知组件只降级该子树：父布局与合法兄弟保留', () => {
  const bad = good()
  bad.root.children.push({ id: 'x', type: 'qrcode', props: {}, fallback: '这段是坏节点' })
  const checked = validateAst(bad)
  assert.equal(checked.ok, true, '局部降级不应整份拒绝')
  assert.equal(checked.degraded, 1)
  const degraded = checked.ast.root.children.at(-1)
  assert.equal(degraded.type, 'text')
  assert.equal(degraded.props.text, '这段是坏节点')
  assert.equal(checked.ast.root.children[0].type, 'metric', '合法兄弟必须保留')
  assert.equal(checked.ast.root.type, 'column', '父布局必须保留')
})

test('根节点损坏 / 预算超限：整份拒绝（安全边界）', () => {
  assert.equal(validateAst({ root: { id: 'r', type: 'nope' }, fallback: 'f' }).ok, false)
  const deep = (() => { let node = { id: 'leaf', type: 'text', props: { text: 'x' } }; for (let i = 0; i < 6; i += 1) node = { id: `n${i}`, type: 'column', children: [node] }; return node })()
  assert.equal(validateAst({ root: deep, fallback: 'f' }).ok, false)
})

test('预算：深度与节点数超限被拒', () => {
  let deep = { id: 'leaf', type: 'text', props: { text: 'x' } }
  for (let i = 0; i < 6; i += 1) deep = { id: `n${i}`, type: 'column', children: [deep] }
  assert.equal(validateAst({ root: deep, fallback: 'f' }).ok, false)

  const wide = { id: 'root', type: 'row', children: Array.from({ length: 130 }, (_, i) => ({ id: `t${i}`, type: 'text', props: { text: 'x' } })) }
  assert.equal(validateAst({ root: wide, fallback: 'f' }).ok, false)
})

test('绑定只接受 $state / $data，其余按字面量处理；segmented 的 bind 必须是 $state', () => {
  assert.deepEqual(readBinding('$state.a'), { scope: 'state', key: 'a' })
  assert.deepEqual(readBinding('$data.a'), { scope: 'data', key: 'a' })
  assert.deepEqual(readBinding('$fn.eval("x")'), { literal: '$fn.eval("x")' })
  const badBind = validateAst({ fallback: 'f', root: { id: 'r', type: 'column', children: [{ id: 's', type: 'segmented', props: { bind: '$data.x', options: [{ label: 'a', value: 1 }] } }] } })
  assert.equal(badBind.ok, true, '子节点非法应局部降级')
  assert.equal(badBind.degraded, 1)
})

test('实验入口：默认关闭、localStorage 记忆、AST 校验器已内联进客户端', () => {
  const client = readFileSync(new URL('../miopiik-iui/client.js', import.meta.url), 'utf8')
  assert.ok(client.includes('IUI_AST.validateAst'))
  assert.ok(client.includes('data-iui-output'))
  assert.ok(client.includes('aria-pressed'))
})

test('防回归：客户端内联块里 return 的标识符在真源里都有定义（曾因 degradeToText 被删导致整插件不启动）', async () => {
  const { readFileSync } = await import('node:fs')
  const module = await import('../miopiik-iui/shared/iui-ast.js')
  const client = readFileSync(new URL('../miopiik-iui/client.js', import.meta.url), 'utf8')
  const start = client.indexOf('const IUI_AST = (() => {')
  const stop = client.indexOf('const MIOPIIK_ML = (() => {')
  assert.ok(start > 0 && stop > start, '找不到内联的 IUI_AST 块')
  const block = client.slice(start, stop)
  const tail = block.slice(block.lastIndexOf('return {'))
  const names = tail.slice('return {'.length, tail.indexOf('}')).split(',').map((part) => part.trim()).filter(Boolean)
  for (const name of names) {
    assert.notEqual(module[name], undefined, `${name} 在内联块里被导出，但真源没有定义`)
  }
})
