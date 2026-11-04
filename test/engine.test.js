import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openStore } from '../miopiik-dsh/host/store.js'
import { Engine } from '../miopiik-dsh/host/engine.js'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 10, 1, 10, 0, 0)

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'miopiik-test-'))
  const store = await openStore(dir, 'session-1')
  let clock = T0
  const engine = new Engine({ store, sessionId: 'session-1', now: () => clock })
  return {
    dir,
    store,
    engine,
    advance(ms) {
      clock += ms
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('观测：只收用户真人消息与助手最终消息，append-only', async () => {
  const ctx = await fixture()
  try {
    ctx.engine.observe({ type: 'user/message', data: { content: [{ type: 'text', text: '帮我看看竞品' }] } })
    ctx.engine.observe({
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: '好，我先理解一下' }] } },
    })
    await ctx.engine.queue
    const kinds = ctx.engine.state.observations.map((entry) => entry.kind)
    assert.deepEqual(kinds, ['user', 'assistant'])
    assert.equal(ctx.engine.state.observations[0].text, '帮我看看竞品')
  } finally {
    await ctx.cleanup()
  }
})

test('开环：登记、L3 可见、闭合后消失，且跨回放存活', async () => {
  const ctx = await fixture()
  try {
    const loop = await ctx.engine.addLoop({
      text: '展示时机还没定',
      type: 'forming-intent',
      closureCondition: '定下展示规则',
    })
    assert.equal(loop.id, 'L-1')
    assert.match(ctx.engine.l3Text(), /展示时机还没定/)

    await ctx.engine.closeLoop('L-1', { reason: '已定' })
    assert.doesNotMatch(ctx.engine.l3Text(), /展示时机还没定/)

    const reopened = await openStore(ctx.dir, 'session-1')
    assert.equal(reopened.state.loops.get('L-1').status, 'closed')
    assert.equal(reopened.state.loops.get('L-1').closedBy, 'mind')
  } finally {
    await ctx.cleanup()
  }
})

test('老化→休眠→投递预览：结尾是开环改写的疑问句，且只投一次', async () => {
  const ctx = await fixture()
  try {
    await ctx.engine.addLoop({ text: '定位方案 B 还没定', type: 'pending-option' })
    ctx.advance(3 * DAY)
    await ctx.engine.finishTurn(2)
    assert.equal(ctx.engine.listLoops()[0].status, 'dormant')

    let view = ctx.engine.inboxView()
    assert.equal(view.previews.length, 1)
    assert.match(view.previews[0].item.question, /[？?]$/)
    assert.match(view.previews[0].item.claim, /定位方案 B/)

    await ctx.engine.finishTurn(3)
    view = ctx.engine.inboxView()
    assert.equal(view.previews.length, 1, '同一开环只投递一条待读预览')
    assert.match(ctx.engine.l3Text(), /收件箱待读/)

    const reopened = await openStore(ctx.dir, 'session-1')
    assert.equal(reopened.state.inbox.size, 1)
    assert.equal(reopened.state.notes[0].kind, 'preview')
    assert.equal(reopened.state.notes[0].loops[0], 'L-1')
  } finally {
    await ctx.cleanup()
  }
})

test('事实卡：source=user 权威高于 operator，失效后不进工作记忆', async () => {
  const ctx = await fixture()
  try {
    const userFact = await ctx.engine.addFact({ claim: '用户要的是 demo 不是上线', provenance: ['turn-3'], source: 'user' })
    const operatorFact = await ctx.engine.addFact({ claim: '竞品都在首页提 X', provenance: ['O-1'], source: 'operator' })
    const listed = ctx.engine.listFacts()
    assert.equal(listed[0].id, userFact.id, '用户来源排最前')

    await ctx.engine.invalidateFact(operatorFact.id, '证据不足')
    assert.deepEqual(
      ctx.engine.listFacts().map((fact) => fact.id),
      [userFact.id],
    )
    const reopened = await openStore(ctx.dir, 'session-1')
    assert.equal(reopened.state.facts.get(operatorFact.id).stale, true)
  } finally {
    await ctx.cleanup()
  }
})

test('收件箱动作：标记已读之后不再占待读位', async () => {
  const ctx = await fixture()
  try {
    await ctx.engine.addLoop({ text: '一个悬着的事', type: 'promise' })
    ctx.advance(2 * DAY)
    await ctx.engine.finishTurn(1)
    const item = ctx.engine.inboxView().previews[0].item
    await ctx.engine.markInbox(item.id, 'read')
    assert.equal(ctx.engine.inboxView().previews.length, 0)
    const reopened = await openStore(ctx.dir, 'session-1')
    assert.equal(reopened.state.inbox.get(item.id).status, 'read')
  } finally {
    await ctx.cleanup()
  }
})
