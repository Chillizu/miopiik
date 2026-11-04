import test from 'node:test'
import assert from 'node:assert/strict'

import { fallbackPreview, parseCompileOutput } from '../miopiik-dsh/host/compile.js'

test('编译输出：容忍代码围栏与前后废话', () => {
  const parsed = parseCompileOutput('好的，结果如下：\n```json\n{"kind":"preview","claim":"竞品定位与假设相反","question":"要不要改定位？","conf":"high","detail":"3 家中 2 家提了 X"}\n```\n以上。')
  assert.deepEqual(parsed, {
    kind: 'preview',
    claim: '竞品定位与假设相反',
    question: '要不要改定位？',
    conf: 'high',
    detail: '3 家中 2 家提了 X',
  })
})

test('编译输出：absorb 可以没有问题', () => {
  const parsed = parseCompileOutput('{"kind":"absorb","claim":"结果与当前方向无关","conf":"low"}')
  assert.equal(parsed.kind, 'absorb')
  assert.equal(parsed.question, null)
})

test('编译输出不合法时返回 null，绝不猜', () => {
  assert.equal(parseCompileOutput('没有 JSON'), null)
  assert.equal(parseCompileOutput('{"kind":"unknown","claim":"x"}'), null)
  assert.equal(parseCompileOutput('{"kind":"preview","claim":""}'), null)
  assert.equal(parseCompileOutput('{"kind":"absorb"}'), null)
})

test('降级预览：带原文指针与开环指针，让 Mind 自己判断', () => {
  const note = fallbackPreview({ id: 'J-3', loopId: 'L-7' }, 'O-J-3 结束了但编译失败', '要不要看原始结果？')
  assert.equal(note.kind, 'preview')
  assert.deepEqual(note.refs, ['J-3'])
  assert.deepEqual(note.loops, ['L-7'])
  assert.equal(note.conf, 'low')
})
