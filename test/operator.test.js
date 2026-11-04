import test from 'node:test'
import assert from 'node:assert/strict'

import { shouldStall } from '../miopiik-dsh/host/operator.js'

const MIN = 60 * 1000
const base = { observedSeq: 10, lastSeen: 10, lastProgressAt: 1000, stallMs: 6 * MIN, now: 1000 + 7 * MIN }

test('卡住判定：还在跑、观测没变、超过静默阈值', () => {
  assert.equal(shouldStall({ ...base, job: { state: 'running' } }), true)
})

test('有产出就不算卡住（观测序号变了）', () => {
  assert.equal(shouldStall({ ...base, job: { state: 'running' }, observedSeq: 11 }), false)
})

test('没到阈值不报（避免把慢当成死）', () => {
  assert.equal(shouldStall({ ...base, job: { state: 'running' }, now: 1000 + 2 * MIN }), false)
})

test('任务已结束/超时/不存在都不报', () => {
  for (const state of ['done', 'failed', 'timeout', 'stalled']) {
    assert.equal(shouldStall({ ...base, job: { state } }), false, state)
  }
  assert.equal(shouldStall({ ...base, job: undefined }), false)
})
