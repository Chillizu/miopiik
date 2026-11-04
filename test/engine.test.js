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
    ctx.engine.observe({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我看看竞品' }] } })
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

test('观测只收真人提示：goal 轮次与时间上下文不算用户消息', async () => {
  const ctx = await fixture()
  try {
    ctx.engine.observe({
      type: 'user/message',
      data: { source: { kind: 'goal' }, content: [{ type: 'text', text: '<goal_round>…</goal_round>' }] },
    })
    ctx.engine.observe({
      type: 'user/message',
      data: { source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Time sampled…' }] },
    })
    ctx.engine.observe({
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我想做个东西' }] },
    })
    await ctx.engine.queue
    assert.deepEqual(
      ctx.engine.state.observations.map((entry) => entry.text),
      ['我想做个东西'],
    )
  } finally {
    await ctx.cleanup()
  }
})

test('派发任务与笔记：job 落盘、preview 进收件箱、同开环只留一条待读', async () => {
  const ctx = await fixture()
  try {
    const loop = await ctx.engine.addLoop({ text: 'O-J-1：验证定位', type: 'pending-dispatch' })
    await ctx.engine.addJob({ id: 'J-1', label: '验证定位', loopId: loop.id, state: 'running' })
    await ctx.engine.updateJob('J-1', { state: 'done' })

    await ctx.engine.deliverNote({
      kind: 'preview',
      claim: '结果一：定位与假设相反',
      why: 'compile:operator-result',
      refs: ['J-1'],
      loops: [loop.id],
      question: '要不要改定位？',
      conf: 'high',
    })
    await ctx.engine.deliverNote({
      kind: 'preview',
      claim: '结果二：又跑了一遍',
      why: 'compile:operator-result',
      refs: ['J-1'],
      loops: [loop.id],
      question: '要不要再看？',
      conf: 'mid',
    })
    assert.equal(ctx.engine.inboxView().previews.length, 1, '同一开环只保留一条待读')

    const reopened = await openStore(ctx.dir, 'session-1')
    assert.equal(reopened.state.jobs.get('J-1').state, 'done')
    assert.equal(reopened.state.inbox.size, 2, '被合并的条目保留在账本里')
    assert.equal(reopened.state.notes.filter((note) => note.kind === 'preview').length, 2)
  } finally {
    await ctx.cleanup()
  }
})

test('absorb 不进收件箱（看了、判定无需理会）', async () => {
  const ctx = await fixture()
  try {
    const note = await ctx.engine.deliverNote({
      kind: 'absorb',
      claim: '结果与当前方向无关',
      why: 'compile:no-signal',
      refs: [],
      loops: [],
      conf: 'low',
    })
    assert.equal(note.kind, 'absorb')
    assert.equal(ctx.engine.inboxView().previews.length, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('交接简报：Mind 写、Ink 存；隔夜后在 L3 顶部出现（开工先看这个）', async () => {
  const ctx = await fixture()
  try {
    await assert.rejects(() => ctx.engine.saveBriefing({}), /至少要有/)
    await ctx.engine.saveBriefing({
      progress: '定了双日志与三层存根',
      loops: '展示时机未定',
      running: 'J-1 审计在跑',
      drafts: '定位方案 B',
      next: '想先聊展示时机',
    })
    assert.equal(ctx.engine.latestBriefing().progress, '定了双日志与三层存根')

    // 当天：L3 不该出现简报（简报是给明天的自己）
    assert.doesNotMatch(ctx.engine.l3Text(), /交接简报/)

    // 隔夜：L3 顶部出现简报与「下步」
    ctx.advance(DAY)
    const l3 = ctx.engine.l3Text()
    assert.match(l3, /交接简报/)
    assert.match(l3, /下步（你昨天想的）：想先聊展示时机/)
  } finally {
    await ctx.cleanup()
  }
})

test('简报素材：活跃开环、在跑任务、草稿与收件箱', async () => {
  const ctx = await fixture()
  try {
    const loop = await ctx.engine.addLoop({ text: '一个活跃线索', type: 'promise' })
    await ctx.engine.addJob({ id: 'J-1', label: '审计', loopId: loop.id, state: 'running' })
    const materials = ctx.engine.briefingMaterials()
    assert.equal(materials.activeLoops.length, 1)
    assert.equal(materials.running.length, 1)
    assert.deepEqual(materials.drafts, [])
  } finally {
    await ctx.cleanup()
  }
})
