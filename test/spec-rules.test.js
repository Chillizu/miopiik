import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LIMITS,
  UI_PROTOCOL,
  isAllowedMediaPath,
  layoutDepth,
  validateSpec,
} from '../miopiik-dsh/shared/spec-rules.js'

const base = { widget: 'text', props: { paragraphs: ['hello'] }, fallback: 'f' }

test('协议信封与正常 spec', () => {
  const checked = validateSpec(base)
  assert.equal(checked.ok, true)
  assert.equal(checked.spec.protocol, UI_PROTOCOL)
  assert.equal(checked.spec.preset, 'card')
})

test('layout 子项穿透被拦住（非法子项不再静默通过）', () => {
  const checked = validateSpec({
    widget: 'layout',
    props: { direction: 'stack', children: [{ widget: 'mermaid', props: {} }] },
    fallback: 'f',
  })
  assert.equal(checked.ok, false)
  assert.match(checked.errors.join(''), /子项不合法/)
})

test('layout 嵌套深度 > 2 被拒', () => {
  const level3 = { widget: 'text', props: { paragraphs: ['x'] }, fallback: 'y' }
  const level2 = { widget: 'layout', props: { direction: 'row', children: [level3] }, fallback: 'y' }
  const level1 = { widget: 'layout', props: { direction: 'stack', children: [level2] }, fallback: 'y' }
  const root = { widget: 'layout', props: { direction: 'stack', children: [level1] }, fallback: 'f' }
  const checked = validateSpec(root)
  assert.equal(checked.ok, false)
  assert.match(checked.errors.join(''), /最深 2 层/)
})

test('graph：null 节点、重复 id、悬空边、非法边全部被拒', () => {
  assert.equal(validateSpec({ widget: 'graph', props: { nodes: [null] }, fallback: 'f' }).ok, false)
  assert.equal(validateSpec({ widget: 'graph', props: { nodes: [{ id: 'a' }, { id: 'a' }] }, fallback: 'f' }).ok, false)
  assert.equal(validateSpec({ widget: 'graph', props: { nodes: [{ id: 'a' }], edges: [{}] }, fallback: 'f' }).ok, false)
  assert.equal(
    validateSpec({ widget: 'graph', props: { nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'ghost' }] }, fallback: 'f' }).ok,
    false,
  )
  const good = validateSpec({ widget: 'graph', props: { nodes: [{ id: 'a', lane: 'L' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] }, fallback: 'f' })
  assert.equal(good.ok, true)
})

test('dataset：chart 类型、NaN/Infinity、负数、超限都被拒', () => {
  const make = (rows, chart = true) => ({ widget: 'dataset', props: { chart, columns: [{ label: 'a' }], rows }, fallback: 'f' })
  assert.equal(validateSpec(make([['x', 1]], 'bogus')).ok, false)
  assert.equal(validateSpec(make([['x', Number.NaN]])).ok, false)
  assert.equal(validateSpec(make([['x', Number.POSITIVE_INFINITY]])).ok, false)
  assert.equal(validateSpec(make([['x', -1]])).ok, false)
  assert.equal(validateSpec(make(Array.from({ length: LIMITS.rows + 1 }, () => ['x', 1]))).ok, false)
  assert.equal(validateSpec(make([['x', 0]])).ok, true)
})

test('media：本地路径只接受会话 charts 目录下的图片', () => {
  assert.equal(validateSpec({ widget: 'media', props: { path: '/etc/passwd' }, fallback: 'f' }).ok, false)
  assert.equal(validateSpec({ widget: 'media', props: { path: '/tmp/a.png' }, fallback: 'f' }).ok, false)
  const good = '/home/u/w/.dsh/miopiik/sessions/s1/charts/c1.svg'
  assert.equal(isAllowedMediaPath(good), true)
  assert.equal(validateSpec({ widget: 'media', props: { path: good }, fallback: 'f' }).ok, true)
  assert.equal(validateSpec({ widget: 'media', props: { url: 'https://example.com/a.png' }, fallback: 'f' }).ok, true)
  assert.equal(validateSpec({ widget: 'media', props: { url: 'javascript:alert(1)' }, fallback: 'f' }).ok, false)
})

test('未知字段被丢弃，出处字段保留', () => {
  const checked = validateSpec({
    widget: 'text',
    props: { paragraphs: ['x'], css: 'position:fixed', className: 'hack', source: 'git log' },
    fallback: 'f',
  })
  assert.equal(checked.ok, true)
  assert.equal(checked.spec.props.css, undefined)
  assert.equal(checked.spec.props.source, 'git log')
})

test('layoutDepth 与 fallback 文本', () => {
  const checked = validateSpec({
    widget: 'layout',
    props: { direction: 'row', children: [{ widget: 'text', props: { paragraphs: ['x'] }, fallback: 'y' }] },
    fallback: 'f',
  })
  assert.equal(checked.ok, true)
  assert.equal(layoutDepth(checked.spec), 1)
})
