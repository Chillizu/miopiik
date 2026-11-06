import test from 'node:test'
import assert from 'node:assert/strict'

import { danglingRefs, findVerdict, makeNote, validateNote } from '../miopiik-dsh/host/notes.js'

function baseNote(overrides) {
  return makeNote({
    id: 'D-1',
    kind: 'absorb',
    claim: '看了，无需理会',
    why: 'no-signal',
    ...overrides,
  })
}

test('absorb 是最便宜的一条：claim + why 即可', () => {
  assert.deepEqual(validateNote(baseNote()), [])
})

test('非 absorb 必须带 refs', () => {
  const note = baseNote({ kind: 'answer', claim: '可以自答' })
  assert.match(validateNote(note).join(''), /refs/)
})

test('preview 必须连着对话节点（开环 / 分支 / U-n），且以一个问题结尾', () => {
  const bad = baseNote({ kind: 'preview', refs: ['L-1'] })
  const errors = validateNote(bad).join('')
  assert.match(errors, /开环、分支或对话节点/)
  assert.match(errors, /问题/)
  const byBranch = baseNote({ kind: 'preview', refs: ['B-1'], branch: 'B-1', question: '要不要接回？' })
  assert.deepEqual(validateNote(byBranch), [])
  const byUtterance = baseNote({ kind: 'preview', refs: ['U-7'], question: '要不要记为已定结论？' })
  assert.deepEqual(validateNote(byUtterance), [])
  const good = baseNote({
    kind: 'preview',
    refs: ['L-1'],
    loops: ['L-1'],
    question: '要不要现在接着聊？',
  })
  assert.deepEqual(validateNote(good), [])
})

test('verify 必须留 detail；conf 只能是三档，不用数值', () => {
  const note = baseNote({ kind: 'verify', refs: ['F-1'], conf: 0.72 })
  const errors = validateNote(note).join('')
  assert.match(errors, /detail/)
  assert.match(errors, /low\/mid\/high/)
})

test('悬空引用必须被看见', () => {
  const note = baseNote({ kind: 'answer', refs: ['F-1', 'L-9', 'D-2'] })
  const refs = danglingRefs(note, {
    facts: new Map([['F-1', {}]]),
    notes: [{ id: 'D-1' }, { id: 'D-2' }],
    loops: new Map(),
  })
  assert.deepEqual(refs, ['L-9'])
})

test('判决缓存：同一 claim 第二次直接引用', () => {
  const first = makeNote({ id: 'D-1', kind: 'verify', claim: '竞品都在首页提 X', why: 'check', refs: ['F-1'], detail: '证据 4 条' })
  const second = makeNote({ id: 'D-2', kind: 'verify', claim: '竞品都在首页提 X', why: 'check', refs: ['F-1'], detail: '证据 4 条' })
  assert.equal(findVerdict([first], '竞品都在首页提 X')?.id, 'D-1')
  assert.equal(findVerdict([first, second], '别的') , undefined)
})
