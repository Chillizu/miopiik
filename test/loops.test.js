import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTIVE_LOOP_CAP,
  ageLoops,
  asQuestion,
  dayOf,
  makeLoop,
  overflowToDormant,
  statusOf,
} from '../host/loops.js'

const DAY = 24 * 60 * 60 * 1000
const BASE_DAY = dayOf(Date.UTC(2026, 10, 1, 10, 0, 0))

function loopAt(index, at) {
  return makeLoop({
    id: `L-${index}`,
    text: `线索 ${index}`,
    type: 'forming-intent',
    at,
  })
}

test('dayOf 是天轴整数', () => {
  assert.equal(Number.isInteger(BASE_DAY), true)
  assert.equal(dayOf(BASE_DAY * DAY + 5), BASE_DAY)
})

test('老化阈值：2 天休眠、7 天折成一行（SPEC §5.6）', () => {
  const at = BASE_DAY * DAY + 9 * 60 * 60 * 1000
  const loop = loopAt(1, at)
  assert.equal(statusOf(loop, { today: BASE_DAY, epoch: 0 }), 'active')
  assert.equal(statusOf(loop, { today: BASE_DAY + 1, epoch: 0 }), 'active')
  assert.equal(statusOf(loop, { today: BASE_DAY + 2, epoch: 0 }), 'dormant')
  assert.equal(statusOf(loop, { today: BASE_DAY + 6, epoch: 0 }), 'dormant')
  assert.equal(statusOf(loop, { today: BASE_DAY + 7, epoch: 0 }), 'folded')
})

test('闭合/丢弃的开环不再老化', () => {
  const loop = loopAt(1, BASE_DAY * DAY)
  loop.status = 'closed'
  assert.equal(statusOf(loop, { today: BASE_DAY + 30, epoch: 0 }), 'closed')
  loop.status = 'dropped'
  assert.equal(statusOf(loop, { today: BASE_DAY + 30, epoch: 0 }), 'dropped')
})

test('ageLoops 只返回需要改状态的条目', () => {
  const fresh = loopAt(1, BASE_DAY * DAY)
  const old = loopAt(2, (BASE_DAY - 3) * DAY)
  const changes = ageLoops([fresh, old], { today: BASE_DAY, epoch: 0 })
  assert.deepEqual(changes, [['L-2', 'dormant']])
})

test('超过活跃上限：最近没命中的先折，且不删', () => {
  const loops = []
  for (let index = 0; index < ACTIVE_LOOP_CAP + 2; index += 1) {
    const loop = loopAt(index + 1, BASE_DAY * DAY)
    loop.lastTouchedAt = BASE_DAY * DAY + index
    loops.push(loop)
  }
  const folded = overflowToDormant(loops)
  assert.equal(folded.length, 2)
  assert.deepEqual(folded, ['L-1', 'L-2'])
  assert.equal(loops.length, ACTIVE_LOOP_CAP + 2, '折叠不删除条目')
})

test('开环改写成疑问句（预览结尾那个问题）', () => {
  const plain = loopAt(1, 0)
  plain.text = '展示时机还没定'
  assert.equal(asQuestion(plain), '展示时机还没定——要不要现在接着聊？')
  plain.text = '要不要现在展示'
  assert.equal(asQuestion(plain), '要不要现在展示？')
})
