import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openStore } from '../host/store.js'
import { Engine } from '../host/engine.js'

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
    const opened = await ctx.engine.openInboxItem(unread[0].id)
    assert.equal(opened.note.kind, 'preview')
    assert.ok(opened.note.detail.length > 100, 'note 里留的是预览，不塞全文')
    assert.ok(opened.detail.length > 400, '全文从详情仓按指针读回，不截断')
    assert.ok(opened.detail.includes('完整报告正文'))

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
    assert.deepEqual(ctx.engine.recentUtterances(5), ['U-1｜第一句', 'U-2｜第二句'])
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

test('对话节奏：只给可见信号（长度/确认型/停顿/有无活跃开环），不给阈值', async () => {
  const ctx = await fixture()
  try {
    const say = (text) =>
      ctx.engine.observe({
        type: 'user/message',
        data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
      })
    say('我想聊聊 MiOpIIk 的定位问题，顺便看看竞品那边到底怎么写的')
    say('嗯')
    say('对')
    await ctx.engine.queue
    const rhythm = ctx.engine.conversationRhythm()
    assert.match(rhythm, /最近三条你说的话/)
    assert.match(rhythm, /2 条是确认型回复/)
    assert.match(rhythm, /没有活跃开环在推进/)
  } finally {
    await ctx.cleanup()
  }
})

test('预览 claim 不泄漏原文：降级时用契约目标，不是 Operator 报告开头', async () => {
  const ctx = await fixture()
  try {
    const { fallbackPreview } = await import('../host/compile.js')
    const note = fallbackPreview(
      { id: 'J-9', loopId: 'L-9', contract: { goal: '确认中间层在这个项目里的名字与职责' } },
      '「确认中间层在这个项目里的名字与职责」有结果了',
      '要不要看原始结果？',
      'Ciallo~~\n\n**交付报告（只读，未修改任何文件）**\n\n## 结论……',
    )
    assert.doesNotMatch(note.claim, /Ciallo|\*\*交付报告/)
    assert.match(note.detail, /Operator 原始报告/)
  } finally {
    await ctx.cleanup()
  }
})

test('纠错的持久链接：很久以前说过、与本次结果相关的话会被捞出来（不只是最近几句）', async () => {
  const ctx = await fixture()
  try {
    const say = (text) =>
      ctx.engine.observe({
        type: 'assistant/message',
        data: { turn: 1, message: { content: [{ type: 'text', text }] } },
      })
    say('竞品都在打价格战，所以我们的定位应该是更便宜')
    for (let index = 0; index < 8; index += 1) say(`无关的第 ${index} 句话，聊点别的`)
    await ctx.engine.queue

    const picked = ctx.engine.relevantUtterances('竞品其实是防御定价，不是价格战', { recent: 2, similar: 2 })
    const ids = picked.map((entry) => entry.id)
    assert.ok(ids.includes('U-1'), `应捞出最早那句，实际：${ids.join(',')}`)
    assert.ok(ids.length <= 4)
    // 最近两句仍然在场（用于指代当下的语气）
    assert.ok(ids.some((id) => id === 'U-9' || id === 'U-8'))
  } finally {
    await ctx.cleanup()
  }
})

test('utterance id 稳定：同一条消息的回放得到同一个 U-n', async () => {
  const ctx = await fixture()
  try {
    ctx.engine.observe({
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: '一句话' }] } },
    })
    await ctx.engine.queue
    const before = ctx.engine.utteranceIndex().map((entry) => entry.id)
    const reopened = await openStore(ctx.dir, 'session-1')
    const engine2 = new Engine({ store: reopened, sessionId: 'session-1', now: () => T0 })
    assert.deepEqual(engine2.utteranceIndex().map((entry) => entry.id), before)
  } finally {
    await ctx.cleanup()
  }
})

test('收工信号：用户道别 → 下一轮 L3 提醒写交接；写了简报后提醒消失', async () => {
  const ctx = await fixture()
  try {
    ctx.engine.observe({
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '先这样，明天再说' }] },
    })
    await ctx.engine.queue
    await ctx.engine.finishTurn(1)
    await ctx.engine.queue

    const l3 = ctx.engine.l3Text()
    assert.match(l3, /这次对话像是在收工/)
    assert.match(l3, /先这样，明天再说/)
    assert.match(l3, /ink_brief save/)

    await ctx.engine.saveBriefing({ progress: '做完了分支切片', next: '接着做草稿态派发' })
    assert.doesNotMatch(ctx.engine.l3Text(), /这次对话像是在收工/)
  } finally {
    await ctx.cleanup()
  }
})

test('收工信号不误报：普通聊天不算道别', async () => {
  const ctx = await fixture()
  try {
    ctx.engine.observe({
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我觉得这个方向可以继续' }] },
    })
    await ctx.engine.queue
    await ctx.engine.finishTurn(1)
    await ctx.engine.queue
    assert.doesNotMatch(ctx.engine.l3Text(), /这次对话像是在收工/)
  } finally {
    await ctx.cleanup()
  }
})

test('鱼骨图数据：只有分叉/汇回/任务产生事件，节点带可展开的详情', async () => {
  const ctx = await fixture()
  try {
    const branch = await ctx.engine.openBranch({ label: '竞品扫描', forkedAtTurn: 3, summary: '确认假设' })
    await ctx.engine.updateBranchContext(branch.id, { premise: '用户怀疑竞品在防御定价' })
    await ctx.engine.addJob({ id: 'J-1', label: '扫描', branchId: branch.id, state: 'running' })
    await ctx.engine.mergeBranch(branch.id, { claim: '竞品其实是防御定价' })

    const graph = ctx.engine.backstageSnapshot().graph
    const kinds = graph.events.map((event) => event.kind)
    assert.ok(kinds.includes('fork'), '应有分叉事件')
    assert.ok(kinds.includes('job'), '应有任务事件')
    assert.ok(kinds.includes('merge'), '应有汇回事件')
    assert.equal(graph.branches.length, 1)

    const node = graph.branches[0]
    assert.equal(node.id, branch.id)
    assert.equal(node.forkTurn, 3)
    assert.equal(node.status, 'merged')
    assert.equal(node.mergeClaim, '竞品其实是防御定价')
    assert.equal(node.premise, '用户怀疑竞品在防御定价')
    assert.equal(node.jobs.length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('鱼骨 links 三源并集：context.facts、job.facts、分支笔记 refs 同权，交集才成线', async () => {
  const ctx = await fixture()
  try {
    // 账上铺 F-1..F-9（照验收样例用 F-9）。
    for (let index = 1; index <= 9; index += 1) {
      await ctx.engine.addFact({ claim: `事实 ${index}`, provenance: ['test'], conf: 'mid' })
      ctx.advance(1000)
    }
    // B-1 / B-2 靠笔记 refs 声明与回声明各认领 F-5；B-3 只靠 job.facts；B-4 只靠 context.facts。
    await ctx.engine.openBranch({ label: '甲线', summary: '无关' })
    ctx.advance(1000)
    await ctx.engine.openBranch({ label: '乙线', summary: '无关' })
    ctx.advance(1000)
    const b3 = await ctx.engine.openBranch({ label: '丙线', summary: '靠 job 声明依赖' })
    ctx.advance(1000)
    const b4 = await ctx.engine.openBranch({ label: '丁线', summary: '靠 context 声明依赖', facts: ['F-9'] })
    ctx.advance(1000)
    await ctx.engine.addJob({ id: 'J-1', label: '带依赖的任务', branchId: b3.id, state: 'done', facts: ['F-9'] })
    ctx.advance(1000)
    await ctx.engine.deliverNote({
      kind: 'answer',
      claim: '甲线的结论靠 F-5',
      why: 'test',
      refs: ['F-5'],
      branch: 'B-1',
    })
    ctx.advance(1000)
    await ctx.engine.updateBranchContext('B-2', { facts: ['F-5'] })
    await ctx.engine.queue

    const links = ctx.engine.backstageSnapshot().graph.links
    assert.deepEqual(links, [
      { kind: 'shared-fact', factId: 'F-5', between: ['B-1', 'B-2'] },
      { kind: 'shared-fact', factId: 'F-9', between: ['B-3', 'B-4'] },
    ])
    // job.facts 随任务记录跨回放存活（append-only JSONL 只增字段）。
    const reopened = await openStore(ctx.dir, 'session-1')
    assert.deepEqual(reopened.state.jobs.get('J-1').facts, ['F-9'])
  } finally {
    await ctx.cleanup()
  }
})

test('鱼骨 links：两分支无任何共同事实时为空数组，悬空 F-* 引用不算依赖', async () => {
  const ctx = await fixture()
  try {
    await ctx.engine.openBranch({ label: '甲线', summary: '各走各的' })
    ctx.advance(1000)
    await ctx.engine.openBranch({ label: '乙线', summary: '各走各的', facts: [] })
    ctx.advance(1000)
    // 挂在甲线的笔记引用了不存在的事实卡：悬空指针不产生依赖，也不报错（校验在投递层）。
    await ctx.engine.deliverNote({
      kind: 'answer',
      claim: '甲线的结论',
      why: 'test',
      refs: ['F-404'],
      branch: 'B-1',
    })
    await ctx.engine.queue
    const graph = ctx.engine.backstageSnapshot().graph
    assert.deepEqual(graph.links, [])
  } finally {
    await ctx.cleanup()
  }
})

test('对话编译静默落账：applyConversationCompile 直接写事实与开环、标记疑似已解、记 absorb 笔记且不占收件箱', async () => {
  const ctx = await fixture()
  try {
    const existingLoop = await ctx.engine.addLoop({ text: '是否默认继承会话模型', type: 'pending-option' })
    const oldFact = await ctx.engine.addFact({ claim: '模型必须手动配置', provenance: ['U-1'], source: 'ink' })

    const note = await ctx.engine.applyConversationCompile({
      claims: [
        { claim: '模型默认继承会话，也可单独配置', refs: ['U-2'], conf: 'mid', supersedes: oldFact.id },
      ],
      loops: [
        { type: 'promise', text: '补一份跨天恢复测试', pointer: 'U-3', closureCondition: '测试通过' },
      ],
      closedLoops: [existingLoop.id],
      question: '',
    })

    assert.equal(note.kind, 'absorb')
    assert.equal(note.why, 'compile:conversation')
    assert.equal(ctx.engine.inboxView({ all: true }).previews.length, 0, '静默落账不产生未读收件箱预览')

    const facts = ctx.engine.listFacts()
    assert.equal(facts.length, 1, '旧事实被取代失效，新事实落账')
    assert.equal(facts[0].claim, '模型默认继承会话，也可单独配置')
    assert.equal(facts[0].source, 'ink')

    const activeLoopList = ctx.engine.listLoops().filter((l) => l.status === 'active')
    assert.equal(activeLoopList.length, 2)
    assert.equal(ctx.engine.state.loops.get(existingLoop.id).suggestedClose, true, '仅标疑似已解，不越权闭合')

    const l3 = ctx.engine.l3Text()
    assert.match(l3, /（Ink 提示：看似已解）/)
    assert.match(l3, /已定结论：\[F-2\] 模型默认继承会话，也可单独配置/)
  } finally {
    await ctx.cleanup()
  }
})

test('低置信闸门：conf=low 的结论不落事实卡，逐条投收件箱、留痕可查，read 可消化', async () => {
  const ctx = await fixture()
  try {
    const note = await ctx.engine.applyConversationCompile({
      claims: [
        { claim: '网关大概率下周上线', refs: ['U-2'], conf: 'low', supersedes: '' },
        { claim: '接口形态还没想清楚', refs: ['U-3'], conf: 'low', supersedes: '' },
      ],
      loops: [],
      closedLoops: [],
      question: '',
    })

    assert.equal(ctx.engine.listFacts().length, 0, '低置信结论一张事实卡都不落')
    assert.equal(note.kind, 'preview', '本批没有可静默结算的内容，返回最后一条低置信预览')
    assert.equal(note.why, 'compile:low-confidence', 'note 留痕 why 可辨')
    assert.match(note.claim, /^后台整理出一条没把握的结论：/)
    assert.equal(note.question, '要不要立为已定结论？')
    assert.equal(
      ctx.engine.state.notes.filter((entry) => entry.why === 'compile:conversation').length,
      0,
      '没有静默结算就不补空 absorb',
    )

    const view = ctx.engine.inboxView({ all: true })
    assert.equal(view.previews.length, 2, '每条低置信结论一条待读预览')
    assert.ok(view.previews.every((entry) => entry.item.claim.startsWith('后台整理出一条没把握的结论：')))
    assert.ok(view.previews.every((entry) => entry.item.question === '要不要立为已定结论？'))

    // 流水里低置信投递行留痕可查：kind 与 why 可辨
    const trace = ctx.engine.state.notes.filter((entry) => entry.why === 'compile:low-confidence')
    assert.equal(trace.length, 2)
    assert.ok(trace.every((entry) => entry.kind === 'preview'))
    assert.ok(trace.some((entry) => entry.refs.includes('U-2')) && trace.some((entry) => entry.refs.includes('U-3')), '预览锚在原话上')

    // 用户 read 消化：条目退出待读，其余仍在
    const first = view.previews[0].item
    await ctx.engine.markInbox(first.id, 'read')
    assert.equal(ctx.engine.state.inbox.get(first.id).status, 'read')
    assert.equal(ctx.engine.inboxView({ all: true }).previews.length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('低置信闸门只作用于 claims：同批 loops 照旧登记、closedLoops 照旧标疑似已解，absorb 留痕有把握的部分', async () => {
  const ctx = await fixture()
  try {
    const existingLoop = await ctx.engine.addLoop({ text: '是否默认继承会话模型', type: 'pending-option' })

    const note = await ctx.engine.applyConversationCompile({
      claims: [{ claim: '接口形态还没想清楚', refs: ['U-3'], conf: 'low', supersedes: '' }],
      loops: [{ type: 'promise', text: '补一份跨天恢复测试', pointer: 'U-3', closureCondition: '测试通过' }],
      closedLoops: [existingLoop.id],
      question: '',
    })

    assert.equal(ctx.engine.listFacts().length, 0, '闸门拦下的结论不落事实卡')
    assert.equal(note.kind, 'absorb', '批里有可静默结算的内容（loops），仍走 compile:conversation 留痕')
    assert.equal(note.why, 'compile:conversation')
    assert.doesNotMatch(note.detail, /接口形态还没想清楚/, 'absorb 明细不含被闸门的结论')

    const activeLoops = ctx.engine.listLoops().filter((loop) => loop.status === 'active')
    assert.equal(activeLoops.length, 2, '新开环照旧登记，旧开环照旧活跃')
    assert.ok(activeLoops.some((loop) => loop.text === '补一份跨天恢复测试'))
    assert.equal(ctx.engine.state.loops.get(existingLoop.id).suggestedClose, true, 'closedLoops 只标疑似已解，不越权闭合')

    assert.equal(ctx.engine.inboxView({ all: true }).previews.length, 1, '低置信结论仍是一条待读')
    assert.equal(ctx.engine.state.notes.filter((entry) => entry.why === 'compile:low-confidence').length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('回归钉住：未标注 conf 的对话结论照旧静默落账，低置信闸门不误伤', async () => {
  const ctx = await fixture()
  try {
    // 形状取自 parseConversationOutput 对未标注 claim 的真实产出（conf: null, supersedes: ''）
    const note = await ctx.engine.applyConversationCompile({
      claims: [{ claim: '模型默认继承会话，也可单独配置', refs: ['U-2'], conf: null, supersedes: '' }],
      loops: [],
      closedLoops: [],
      question: '',
    })

    assert.equal(note.kind, 'absorb')
    assert.equal(note.why, 'compile:conversation')
    assert.equal(ctx.engine.inboxView({ all: true }).previews.length, 0, '不占收件箱')
    assert.ok(note.detail.includes('，置信 low）'), 'absorb 明细与改动前逐字节同形')

    const facts = ctx.engine.listFacts()
    assert.equal(facts.length, 1, '照旧静默落账')
    assert.equal(facts[0].claim, '模型默认继承会话，也可单独配置')
    assert.equal(facts[0].conf, 'low', '未标注沿用原缺省 low，与改动前一致')
    assert.equal(facts[0].source, 'ink')

    // 连 conf 键都不带的裸输入也照旧静默落账（任何调用方都不被闸门误伤）
    await ctx.engine.applyConversationCompile({
      claims: [{ claim: '用户拍板走收件箱方案', refs: ['U-1'] }],
      loops: [],
      closedLoops: [],
      question: '',
    })
    assert.equal(ctx.engine.listFacts().length, 2)
    assert.equal(ctx.engine.inboxView({ all: true }).previews.length, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('混合批次：低置信投收件箱、未标注的照旧落账，absorb 只结算有把握的部分', async () => {
  const ctx = await fixture()
  try {
    const note = await ctx.engine.applyConversationCompile({
      claims: [
        { claim: '用户确认走收件箱方案', refs: ['U-1'], conf: null, supersedes: '' },
        { claim: '网关上线时间还没谱', refs: ['U-3'], conf: 'low', supersedes: '' },
      ],
      loops: [],
      closedLoops: [],
      question: '',
    })

    const facts = ctx.engine.listFacts()
    assert.equal(facts.length, 1, '只有未标注的落了事实卡')
    assert.equal(facts[0].claim, '用户确认走收件箱方案')
    assert.doesNotMatch(note.detail, /网关上线时间还没谱/, 'absorb 明细不含被闸门的结论')
    assert.match(note.detail, /用户确认走收件箱方案/)

    const view = ctx.engine.inboxView({ all: true })
    assert.equal(view.previews.length, 1)
    assert.match(view.previews[0].item.claim, /网关上线时间还没谱/)
    assert.equal(ctx.engine.state.notes.filter((entry) => entry.why === 'compile:low-confidence').length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('收工告别最后一轮悖论：道别回合当场生成今日盘外素材，不锁死队列', async () => {
  const ctx = await fixture()
  try {
    ctx.engine.observe({ type: 'turn/start', data: { turn: 1 } })
    ctx.engine.observe({
      type: 'user/message',
      data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: '先这样，我去睡了' }] },
    })
    ctx.engine.observe({
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: '晚安，明天继续' }] } },
    })
    ctx.engine.observe({ type: 'turn/end', data: { turn: 1 } })
    await ctx.engine.queue

    const materials = ctx.engine.state.briefings.find((record) => record.kind === 'auto-materials')
    assert.ok(materials !== undefined, '道别回合结束时应立即备好盘外素材')
    assert.match(materials.progress, /晚安，明天继续/)
  } finally {
    await ctx.cleanup()
  }
})
