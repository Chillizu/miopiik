import test from 'node:test'
import assert from 'node:assert/strict'

import { makeItem, mergeByLoop, selectView, tierOf, tierName } from '../miopiik-dsh/host/inbox.js'

const activeLoopIds = new Set(['L-1'])

test('层级：阻塞 > 命中活跃开环 > 新结论 > 其余', () => {
  const base = { epoch: 1, createdAt: 0 }
  assert.equal(tierOf(makeItem({ ...base, id: 'I-1', blocking: true }), { currentEpoch: 1, activeLoopIds }), 0)
  assert.equal(tierOf(makeItem({ ...base, id: 'I-2', loopId: 'L-1' }), { currentEpoch: 1, activeLoopIds }), 1)
  assert.equal(tierOf(makeItem({ ...base, id: 'I-3', newConclusion: true }), { currentEpoch: 1, activeLoopIds }), 2)
  assert.equal(tierOf(makeItem({ ...base, id: 'I-4' }), { currentEpoch: 1, activeLoopIds }), 3)
})

test('指不上开环的条目不能占 T1（相关性就是结构）', () => {
  const item = makeItem({ id: 'I-5', loopId: 'L-9', epoch: 1, createdAt: 0 })
  assert.equal(tierOf(item, { currentEpoch: 1, activeLoopIds }), 3)
})

test('epoch 不匹配：降一级，且只降一次', () => {
  const item = makeItem({ id: 'I-6', loopId: 'L-1', epoch: 0, createdAt: 0 })
  assert.equal(tierOf(item, { currentEpoch: 1, activeLoopIds }), 2)
  const top = makeItem({ id: 'I-7', blocking: true, epoch: 0, createdAt: 0 })
  assert.equal(tierOf(top, { currentEpoch: 1, activeLoopIds }), 1)
})

test('同一开环最多一条待读：新的保留，旧的标 superseded', () => {
  const older = makeItem({ id: 'I-1', loopId: 'L-1', createdAt: 10 })
  const newer = makeItem({ id: 'I-2', loopId: 'L-1', createdAt: 20 })
  assert.deepEqual(mergeByLoop([older, newer]), ['I-1'])
  assert.deepEqual(mergeByLoop([newer, older]), ['I-1'])
})

test('每轮最多 3 条完整预览 + 一行计数，按层级排序', () => {
  const items = [
    makeItem({ id: 'I-1', epoch: 1, createdAt: 1 }),
    makeItem({ id: 'I-2', epoch: 1, newConclusion: true, createdAt: 2 }),
    makeItem({ id: 'I-3', epoch: 1, loopId: 'L-1', createdAt: 3 }),
    makeItem({ id: 'I-4', epoch: 1, blocking: true, createdAt: 4 }),
    makeItem({ id: 'I-5', epoch: 1, loopId: 'L-1', createdAt: 5 }),
  ]
  const view = selectView(items, { currentEpoch: 1, activeLoopIds })
  assert.equal(view.previews.length, 3)
  assert.equal(view.hiddenCount, 2)
  assert.deepEqual(
    view.previews.map((entry) => entry.item.id),
    ['I-4', 'I-5', 'I-3'],
  )
  assert.deepEqual(view.byTier, { T0: 1, T1: 2, T2: 1, T3: 1 })
  assert.equal(tierName(0), 'T0')
})

test('已读与星标不占待读位', () => {
  const read = makeItem({ id: 'I-1', loopId: 'L-1', status: 'read', createdAt: 1 })
  const starred = makeItem({ id: 'I-2', loopId: 'L-1', status: 'starred', createdAt: 2 })
  const view = selectView([read, starred], { currentEpoch: 1, activeLoopIds })
  assert.equal(view.previews.length, 0)
})
