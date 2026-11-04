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

test('话题 epoch 由 Mind 推进：持久化，且让旧预览变 stale（降一级不删）', async () => {
  const ctx = await fixture()
  try {
    const loop = await ctx.engine.addLoop({ text: '一个悬着的事', type: 'promise' })
    await ctx.engine.deliverNote({
      kind: 'preview',
      claim: '旧话题的结论',
      why: 'compile:operator-result',
      refs: [loop.id],
      loops: [loop.id],
      question: '要不要看？',
      conf: 'mid',
    })
    assert.equal(ctx.engine.inboxView().previews[0].tier, 1)

    const result = await ctx.engine.advanceEpoch({ note: '换话题了' })
    assert.equal(result.epoch, 1)
    assert.equal(ctx.engine.inboxView().previews[0].tier, 2, 'epoch 不匹配降一级')

    const reopened = await openStore(ctx.dir, 'session-1')
    assert.equal(reopened.state.epoch, 1, 'epoch 跨回放存活')
    assert.equal(reopened.state.inbox.size, 1, '过期不等于作废')
  } finally {
    await ctx.cleanup()
  }
})

test('收件箱三区与展开：unread / starred / history，展开能取回 note 的 detail', async () => {
  const ctx = await fixture()
  try {
    const loop = await ctx.engine.addLoop({ text: '一个悬着的事', type: 'promise' })
    await ctx.engine.deliverNote({
      kind: 'preview',
      claim: '审计结论',
      why: 'compile:operator-result',
      refs: [loop.id],
      loops: [loop.id],
      question: '先修哪个？',
      conf: 'high',
      detail: '完整报告正文……'.repeat(100),
    })
    const unread = ctx.engine.inboxZone('unread')
    assert.equal(unread.length, 1)
    const opened = ctx.engine.openInboxItem(unread[0].id)
    assert.equal(opened.note.kind, 'preview')
    assert.ok(opened.note.detail.length > 400, 'detail 不截断到 120 字')

    await ctx.engine.markInbox(unread[0].id, 'star')
    assert.equal(ctx.engine.inboxZone('starred').length, 1)
    assert.equal(ctx.engine.inboxZone('unread').length, 0)

    await ctx.engine.markInbox(unread[0].id, 'read')
    assert.equal(ctx.engine.inboxZone('history').length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('无损存储：观测文本不按 4000 字截断', async () => {
  const ctx = await fixture()
  try {
    const long = '很长的用户消息。'.repeat(500) // 3500+ 字
    ctx.engine.observe({
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: long }] },
    })
    await ctx.engine.queue
    assert.equal(ctx.engine.state.observations[0].text.length, long.length)
  } finally {
    await ctx.cleanup()
  }
})

test('L3：收件箱预览带结尾问题，顺序为简报→收件箱→开环', async () => {
  const ctx = await fixture()
  try {
    await ctx.engine.saveBriefing({ progress: '推进了一点', next: '想先聊展示' })
    ctx.advance(DAY)
    const loop = await ctx.engine.addLoop({ text: '一个悬着的事', type: 'promise' })
    await ctx.engine.deliverNote({
      kind: 'preview',
      claim: '一条结论',
      why: 'compile:operator-result',
      refs: [loop.id],
      loops: [loop.id],
      question: '要不要看？',
      conf: 'mid',
    })
    const l3 = ctx.engine.l3Text()
    assert.match(l3, /→ 要不要看？/)
    const iBrief = l3.indexOf('交接简报')
    const iInbox = l3.indexOf('收件箱待读')
    const iLoops = l3.indexOf('悬着的事：活跃')
    assert.ok(iBrief < iInbox && iInbox < iLoops, `顺序不对：${iBrief}/${iInbox}/${iLoops}`)
  } finally {
    await ctx.cleanup()
  }
})

test('草稿区：add/list/drop，闸门批准后转 committed，拒绝后转 rejected（不要求用户修理）', async () => {
  const ctx = await fixture()
  try {
    const draft = await ctx.engine.addDraft({ title: '定位方案 B', summary: '还缺用户偏好', conf: 'mid' })
    assert.equal(draft.id, 'P-1')
    assert.equal(ctx.engine.listDrafts().length, 1)
    assert.equal(ctx.engine.briefingMaterials().drafts[0].title, '定位方案 B')

    const committed = await ctx.engine.settleDraft('P-1', { status: 'committed', reason: 'gate:approved' })
    assert.equal(committed.status, 'committed')
    assert.equal(ctx.engine.listDrafts().length, 0, 'settled 草稿不再出现在待办列表')

    const draft2 = await ctx.engine.addDraft({ title: '另一个', conf: 'low' })
    const rejected = await ctx.engine.settleDraft(draft2.id, { status: 'rejected', reason: 'gate:rejected-by-user' })
    assert.equal(rejected.status, 'rejected')
    const reopened = await openStore(ctx.dir, 'session-1')
    assert.equal(reopened.state.drafts.get('P-1').status, 'committed')
    assert.equal(reopened.state.drafts.get(draft2.id).status, 'rejected')
  } finally {
    await ctx.cleanup()
  }
})

test('草稿天轴老化：一周没碰自动 expired', async () => {
  const ctx = await fixture()
  try {
    const draft = await ctx.engine.addDraft({ title: '会过期的草稿' })
    ctx.advance(8 * DAY)
    await ctx.engine.finishTurn(1)
    assert.equal(ctx.engine.listDrafts().length, 0)
    assert.equal(ctx.engine.state.drafts.get(draft.id).status, 'expired')
  } finally {
    await ctx.cleanup()
  }
})

test('简报：超过一屏拒绝；隔夜更新追加且不覆盖原句；L3 逐条显示', async () => {
  const ctx = await fixture()
  try {
    await assert.rejects(() => ctx.engine.saveBriefing({ progress: '长'.repeat(2000), next: 'x' }), /超过一屏/)
    await ctx.engine.saveBriefing({ progress: '完成 Batch 5', next: '补草稿区' })
    await ctx.engine.appendBriefingUpdate('凌晨 Operator 跑完了，结论在 I-1')
    ctx.advance(DAY)
    const l3 = ctx.engine.l3Text()
    assert.match(l3, /交接简报/)
    assert.match(l3, /隔夜更新：凌晨 Operator 跑完了/)
    assert.match(l3, /下步（你昨天想的）：补草稿区/)
  } finally {
    await ctx.cleanup()
  }
})

test('硬断：跨天但没有收工简报时，L3 要求先承认断点', async () => {
  const ctx = await fixture()
  try {
    ctx.engine.observe({
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '先这样，明天再聊' }] },
    })
    await ctx.engine.queue
    ctx.advance(DAY)
    const l3 = ctx.engine.l3Text()
    assert.match(l3, /没有收工简报——先承认断点/)
  } finally {
    await ctx.cleanup()
  }
})

test('Operator 问答：能引用就自答（事实卡 → 生成判例），同类问题第二次引判例', async () => {
  const ctx = await fixture()
  try {
    const fact = await ctx.engine.addFact({
      claim: '中间层叫 Ink，负责编译、校验与记账',
      provenance: ['SPEC §0'],
      source: 'user',
    })
    const first = await ctx.engine.answerOperatorQuestion({ question: '中间层负责什么', childId: null })
    assert.equal(first.kind, 'answer')
    assert.equal(first.source, 'fact')
    assert.deepEqual(first.citations, [fact.id])
    assert.equal(ctx.engine.listCases()[0].answer, fact.claim)

    const second = await ctx.engine.answerOperatorQuestion({ question: '中间层是干嘛的', childId: null })
    assert.equal(second.kind, 'answer')
    assert.equal(second.source, 'precedent')
    assert.equal(ctx.engine.listCases().length, 1, '引判例不再新增判例')
  } finally {
    await ctx.cleanup()
  }
})

test('Operator 问答：要发明就上报——blocking 预览进收件箱，Operator 拿到"按契约继续"', async () => {
  const ctx = await fixture()
  try {
    const result = await ctx.engine.answerOperatorQuestion({ question: '今天食堂有没有开', childId: null })
    assert.equal(result.kind, 'escalated')
    assert.match(result.message, /按契约/)
    const view = ctx.engine.inboxView({ all: true })
    assert.equal(view.previews.length, 1)
    assert.equal(view.previews[0].tier, 0, 'blocking 进 T0')
    const note = ctx.engine.state.notes[0]
    assert.equal(note.kind, 'hold')
    assert.equal(note.why, 'no-citation')
  } finally {
    await ctx.cleanup()
  }
})

test('纠错前置：最近说过的话可被编译取用（首行、限条数）', async () => {
  const ctx = await fixture()
  try {
    for (const text of ['第一句\n细节', '第二句']) {
      ctx.engine.observe({
        type: 'assistant/message',
        data: { turn: 1, message: { content: [{ type: 'text', text }] } },
      })
    }
    await ctx.engine.queue
    assert.deepEqual(ctx.engine.recentUtterances(5), ['第一句', '第二句'])
  } finally {
    await ctx.cleanup()
  }
})

test('硬断事后折叠：跨天无简报时自动整理盘外素材，并在 L3 展示（不代写简报）', async () => {
  const ctx = await fixture()
  try {
    ctx.engine.observe({
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '先这样' }] },
    })
    ctx.engine.observe({
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: '好，明天见' }] } },
    })
    await ctx.engine.queue
    const loop = await ctx.engine.addLoop({ text: '明天继续的事', type: 'promise' })

    ctx.advance(DAY)
    await ctx.engine.detectGap()

    const materials = ctx.engine.state.briefings.find((record) => record.kind === 'auto-materials')
    assert.ok(materials !== undefined, '应生成盘外素材')
    assert.match(materials.loops, new RegExp(loop.id))

    const l3 = ctx.engine.l3Text()
    assert.match(l3, /没有收工简报——先承认断点/)
    assert.match(l3, /盘外素材·推进：好，明天见/)
    assert.match(l3, /盘外素材·悬着/)
  } finally {
    await ctx.cleanup()
  }
})
