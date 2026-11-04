import test from 'node:test'
import assert from 'node:assert/strict'

import { fallbackPreview, parseCompileOutput } from '../miopiik-dsh/host/compile.js'
import { tierOf } from '../miopiik-dsh/host/inbox.js'

test('编译输出：容忍代码围栏与前后废话', () => {
  const parsed = parseCompileOutput('好的，结果如下：\n```json\n{"kind":"preview","claim":"竞品定位与假设相反","question":"要不要改定位？","conf":"high","detail":"3 家中 2 家提了 X"}\n```\n以上。')
  assert.deepEqual(parsed, {
    kind: 'preview',
    claim: '竞品定位与假设相反',
    question: '要不要改定位？',
    conf: 'high',
    detail: '3 家中 2 家提了 X',
    contradicts: false,
    contradictStatement: '',
  })
})

test('编译输出：absorb 可以没有问题', () => {
  const parsed = parseCompileOutput('{"kind":"absorb","claim":"结果与当前方向无关","conf":"low"}')
  assert.equal(parsed.kind, 'absorb')
  assert.equal(parsed.question, null)
})

test('编译输出：能标出与 Mind 旧话矛盾的报告，并带上原句', () => {
  const parsed = parseCompileOutput(
    '{"kind":"preview","claim":"竞品其实是防御定价","question":"要不要纠正？","conf":"mid","contradicts":true,"contradictStatement":"竞品都在打价格战"}',
  )
  assert.equal(parsed.contradicts, true)
  assert.equal(parsed.contradictStatement, '竞品都在打价格战')
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

test('分支上的任务：编译出的预览带分支指针（落在 T1，而不是掉进 T3）', () => {
  const note = fallbackPreview(
    { id: 'J-6', loopId: 'L-10', branchId: 'B-2', contract: { goal: '复述分支前提' } },
    '「复述分支前提」有结果了',
    '要不要看原始结果？',
    '报告正文',
  )
  assert.equal(note.branch, 'B-2')
  const item = { blocking: false, loopId: null, branchId: 'B-2', newConclusion: false, epoch: 0, createdAt: 1 }
  assert.equal(tierOf(item, { currentEpoch: 0, activeLoopIds: new Set() }), 1)
})
