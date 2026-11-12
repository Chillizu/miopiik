import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { IUI_VERSION, readBinding, resolveValue, validateAst } from '../miopiik-dsh/shared/iui-ast.js'

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

test('未知组件类型整树不合法（由调用方降级为 fallback）', () => {
  const bad = good()
  bad.root.children.push({ id: 'x', type: 'qrcode', props: {} })
  const checked = validateAst(bad)
  assert.equal(checked.ok, false)
  assert.match(checked.errors.join(''), /未知组件类型/)
  assert.equal(checked.fallback, 'f')
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
  assert.equal(validateAst({ fallback: 'f', root: { id: 'r', type: 'segmented', props: { bind: '$data.x', options: [{ label: 'a', value: 1 }] } } }).ok, false)
})

test('实验入口：默认关闭、localStorage 记忆、AST 校验器已内联进客户端', () => {
  const client = readFileSync(new URL('../miopiik-dsh/client.js', import.meta.url), 'utf8')
  assert.ok(client.includes("localStorage.getItem(DSL_PREVIEW_KEY) === '1'"))
  assert.ok(client.includes('IUI_AST.validateAst'))
  assert.ok(client.includes('data-iui-output'))
  assert.ok(client.includes('aria-pressed'))
})
