import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openStore } from '../host/store.js'
import { Engine } from '../host/engine.js'
import { collectMindRows, MIND_EVENTS_MAX } from '../host/audit.js'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 10, 1, 10, 0, 0)

async function fixture({ workspaceRoot = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'miopiik-mind-'))
  const store = await openStore(dir, 'session-1', workspaceRoot === null ? {} : { workspaceRoot })
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

const MIND_KINDS = new Set([
  'branch.fork',
  'branch.summary',
  'branch.context',
  'branch.merge',
  'branch.abandon',
  'loop.add',
  'loop.close',
  'loop.drop',
  'inbox.read',
  'inbox.star',
  'inbox.unstar',
  'inbox.defer',
  'job.dispatch',
  'fact.add',
  'fact.revise',
  'draft.add',
  'draft.settle',
  'briefing',
  'briefing.overnight',
  'fold.apply',
  'fold.reject',
])

/**
 * 真账本夹具：只经 Engine 的真实落账路径铺一层覆盖 §13.10 全口径的事件，
 * ink / operator / user 署名的行也照真实路径落（不手写伪造记录）。
 */
async function seedMindLedger(ctx) {
  const { engine } = ctx
  const step = (ms = 1000) => ctx.advance(ms)
  // —— Mind 手笔（全收口径）——
  await engine.addLoop({ text: 'Mind 手笔要在视图上可见', type: 'forming-intent', closureCondition: '三视图署名落地' })
  step()
  await engine.addFact({ claim: '用户裁决：署名要可指认', provenance: ['U-1'], source: 'user' })
  step()
  const branch = await engine.openBranch({ label: '署名线', summary: 'Mind 泳道', premise: '视图要能认出谁干的', facts: ['F-1'] })
  step()
  await engine.updateBranchSummary(branch.id, '补一句摘要')
  step()
  await engine.addJob({ id: 'J-1', label: '验证派发署名', branchId: branch.id, state: 'running', startedAt: engine.now(), loopId: 'L-1' })
  step()
  const draft = await engine.addDraft({ title: 'Mind 的半成品', summary: '还没到提交门' })
  step()
  await engine.settleDraft(draft.id, { status: 'committed', reason: 'gate:approved' })
  step()
  await engine.saveBriefing({ progress: '铺账本', next: '验口径' })
  step()
  await engine.appendBriefingUpdate('夜里补了一条：口径要写进 SPEC')
  step()
  const fold = await engine.proposeFold({ archive: '用户：署名要可指认\n我：Mind 手笔要在视图上可见' })
  await engine.settleFold(fold.id, { approve: true })
  step()
  // —— ink / operator / user 署名（绝不进 mindEvents 的反向样例）——
  await engine.addFact({ claim: '后台推断的结论', provenance: ['compile'], conf: 'low' }) // source 缺省 = ink
  step()
  await engine.addFact({ claim: 'Operator 报回来的结论', provenance: ['job:J-1'], source: 'operator' })
  step()
  await engine.addLoop({ text: 'O-J-9：派发记账开环', type: 'pending-dispatch', pointer: 'J-9' }) // operator.js 的记账形状
  step()
  await engine.updateJob('J-1', { state: 'done', endedAt: engine.now(), stopReason: 'completed' }) // operator
  step()
  await engine.closeLoop('L-2', { reason: 'draft:settled', by: 'ink' }) // 草稿收尾的 Ink 闭合
  step()
  await engine.dropLoop('L-2', { reason: 'intervention:ui', by: 'user' }) // 界面干预
  step()
  await engine.addDraft({ title: 'Operator 草稿态结果', summary: '后台跑的', source: 'operator' })
  step()
  const expired = await engine.addDraft({ title: '会过期的草稿', summary: '七日无人碰' })
  await engine.settleDraft(expired.id, { status: 'expired', reason: 'aging:7d' })
  step()
  await engine.foldDay(20758) // auto-materials：Ink 整理的盘外素材
  step()
  await engine.deliverNote({ kind: 'absorb', claim: '这轮在看账本本身', why: 'no-signal', conf: 'low', refs: [] }) // notes = ink
  step()
  await engine.mergeBranch(branch.id, { claim: '署名线收口' }) // Mind：并回
  step()
  await engine.abandonBranch((await engine.openBranch({ label: '放弃线', summary: '验证 abandon' })).id, { reason: '验证完毕' })
  step()
  // 收件箱三条 Mind 读法 + Ink 的投递。
  await engine.deliverNote({ kind: 'preview', claim: '「Mind 手笔要在视图上可见」有新进展', why: 'compile:conversation', question: '现在收吗？', refs: ['L-1'], loops: ['L-1'] })
  await engine.markInbox('I-1', 'read')
  step()
  await engine.markInbox('I-1', 'star')
  step()
  await engine.markInbox('I-1', 'unstar')
  step()
  await engine.markInbox('I-1', 'defer')
  step()
  await engine.closeLoop('L-1', { reason: '收到', by: 'mind' })
  step()
  await engine.reviseFact('F-1', { claim: '用户裁决：署名要可指认（改写）' })
  await engine.queue
}

test('mind 事件流：真账本夹具下 Mind 手笔全收，行形状 {id, at, kind, label, refs}', async () => {
  const ctx = await fixture()
  try {
    await seedMindLedger(ctx)
    const rows = ctx.engine.backstageSnapshot().graph.mindEvents
    const byKey = (kind, id) => rows.find((row) => row.kind === kind && row.id === id)
    // 契约点名的四种手笔都在，label 就是「动词 + 账本 id」。
    assert.ok(byKey('branch.merge', 'B-1') !== undefined, '并回 B-1 应在')
    assert.equal(byKey('branch.merge', 'B-1').label, '并回 B-1')
    assert.deepEqual(byKey('branch.merge', 'B-1').refs.slice(0, 1), ['B-1'])
    assert.equal(byKey('branch.merge', 'B-1').refs.length, 2, '并回带汇回 note 的指针')
    assert.ok(byKey('job.dispatch', 'J-1') !== undefined, '派发 J-1 应在')
    assert.equal(byKey('job.dispatch', 'J-1').label, '派发 J-1')
    assert.deepEqual(byKey('job.dispatch', 'J-1').refs, ['J-1', 'L-1'])
    assert.equal(byKey('loop.close', 'L-1').label, '闭合 L-1')
    assert.equal(byKey('inbox.read', 'I-1').label, '读收件箱 I-1')
    // 其余口径逐类核对（label 都从记录可判定字段拼出来）。
    const expected = [
      ['loop.add', 'L-1', '开环 L-1'],
      ['fact.add', 'F-1', '立事实 F-1'],
      ['branch.fork', 'B-1', '开线 B-1'],
      ['branch.context', 'B-1', '补上下文 B-1'],
      ['branch.summary', 'B-1', '补摘要 B-1'],
      ['draft.add', 'P-1', '落草稿 P-1'],
      ['draft.settle', 'P-1', '了草稿 P-1（committed）'],
      ['briefing', null, '写交接简报（第 20758 天）'],
      ['briefing.overnight', null, '补隔夜更新'],
      ['fold.apply', 'A-1', '落折叠 A-1'],
      ['branch.abandon', 'B-2', '放弃 B-2'],
      ['inbox.star', 'I-1', '标星 I-1'],
      ['inbox.unstar', 'I-1', '取消星标 I-1'],
      ['inbox.defer', 'I-1', '缓读 I-1'],
      ['fact.revise', 'F-1', '修订 F-1'],
    ]
    for (const [kind, id, label] of expected) {
      const hit = id === null ? rows.find((row) => row.kind === kind) : byKey(kind, id)
      assert.ok(hit !== undefined, `${kind} 应在 mind 事件流里`)
      assert.equal(hit.label, label, `${kind} 的 label 应为「${label}」`)
      assert.equal(hit.id, id ?? hit.id)
    }
    // 行形状契约：只有这五个键，且 at 可比时间。
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['at', 'id', 'kind', 'label', 'refs'])
      assert.ok(Number.isFinite(row.at))
      assert.ok(MIND_KINDS.has(row.kind), `不该出现非 Mind 口径的 kind: ${row.kind}`)
    }
    // 升序：旧→新。
    const ats = rows.map((row) => row.at)
    assert.deepEqual(ats, [...ats].sort((a, b) => a - b))
  } finally {
    await ctx.cleanup()
  }
})

test('mind 事件流：ink / operator / user 署名的行绝不进（合成夹具反向样例）', async () => {
  const ctx = await fixture()
  try {
    await seedMindLedger(ctx)
    const rows = ctx.engine.backstageSnapshot().graph.mindEvents
    // notes（absorb/preview…）是 Ink 的；epoch/fold 观测也不进。
    assert.equal(rows.some((row) => !MIND_KINDS.has(row.kind)), false, '出现口径外的 kind')
    // 各条反向样例逐个点名。
    const claims = rows.map((row) => `${row.kind}:${row.id}`)
    assert.equal(claims.includes('loop.add:L-2'), false, '派发记账开环（pending-dispatch + J-* 指针）是 Operator 的，不进')
    assert.equal(rows.some((row) => row.kind === 'job.update'), false, 'job.update 是执行层落账，不进')
    assert.equal(rows.some((row) => row.kind === 'branch.attach-job'), false, 'attach-job 是 Ink 的机械挂接，不进')
    assert.equal(rows.some((row) => row.kind === 'inbox.deliver' || row.kind === 'inbox.supersede'), false, '投递/顶替是 Ink 的，不进')
    assert.equal(rows.some((row) => row.kind === 'fact.add' && row.id === 'F-2'), false, 'source 缺省（ink）的事实不进')
    assert.equal(rows.some((row) => row.kind === 'fact.add' && row.id === 'F-3'), false, 'source=operator 的事实（ink_report 形状）不进')
    assert.equal(rows.some((row) => row.kind === 'loop.close' && row.id === 'L-2'), false, 'by=ink 的闭合不进')
    assert.equal(rows.some((row) => row.kind === 'loop.drop' && row.id === 'L-2'), false, 'by=user 的界面干预不进')
    assert.equal(rows.some((row) => row.kind === 'draft.add' && row.id === 'P-2'), false, 'Operator 草稿态结果的落账不进')
    assert.equal(rows.some((row) => row.kind === 'draft.settle' && row.id === 'P-3'), false, '七天过期（Ink 老化）不进')
    assert.equal(rows.some((row) => row.kind === 'briefing.auto-materials'), false, '盘外素材是 Ink 的，不进')
    assert.equal(rows.some((row) => row.kind === 'fold.propose'), false, '折叠提案是 Ink 的，不进')
    assert.equal(rows.filter((row) => row.kind === 'loop.add').length, 1, '只有 Mind 手写的开环进了')
    // 同一份账本在 audit 通道里看得到这些行：口径差异（同源账本、不同署名面）如实呈现。
    const auditRows = ctx.engine.auditPage({ limit: 200 }).rows
    assert.ok(auditRows.some((row) => row.kind === 'job.update'), 'audit 里 job.update 在（它是 operator 署名）')
    assert.ok(auditRows.some((row) => row.kind === 'fact.add' && row.actor === 'operator'), 'audit 里 operator 事实在')
  } finally {
    await ctx.cleanup()
  }
})

test('mind 事件流：派发记账开环可判定剔除，Mind 手写 pending-dispatch 不误伤', async () => {
  const ctx = await fixture()
  try {
    // 记账形状：type=pending-dispatch 且 pointer=J-*（operator.js 逐字段就是这个形状）→ 剔除。
    await ctx.engine.addLoop({ text: 'O-J-3：派发记账', type: 'pending-dispatch', pointer: 'J-3' })
    // Mind 手写：同为 pending-dispatch 但指针不是 J-*（比如指向轮次）→ 照收。
    await ctx.engine.addLoop({ text: '等用户拍板的选项', type: 'pending-dispatch', pointer: 'turn:12' })
    await ctx.engine.queue
    const rows = collectMindRows(ctx.dir, null)
    assert.equal(rows.some((row) => row.id === 'L-1'), false, 'J-* 指针的 pending-dispatch 是记账，不进')
    assert.equal(rows.some((row) => row.id === 'L-2'), true, '非 J-* 指针的开环是 Mind 手笔，照收')
  } finally {
    await ctx.cleanup()
  }
})

test('mind 事件流：截窗生效——只留最近 40 条，最早的动作让位', async () => {
  const ctx = await fixture()
  try {
    await ctx.engine.addLoop({ text: '最早的开环 0', type: 'forming-intent' })
    for (let index = 1; index <= 45; index += 1) {
      ctx.advance(100)
      await ctx.engine.addLoop({ text: `开环 ${index}`, type: 'forming-intent' })
    }
    await ctx.engine.queue
    const rows = collectMindRows(ctx.dir, null)
    assert.equal(rows.length, MIND_EVENTS_MAX, `截窗上限 ${MIND_EVENTS_MAX} 条`)
    assert.equal(rows[0].label, '开环 L-7', '最早 6 条被截掉（L-1–L-6 不在窗内）')
    assert.equal(rows.at(-1).label, '开环 L-46', '最新一条在窗内')
    assert.equal(rows.some((row) => row.label === '开环 L-1'), false)
  } finally {
    await ctx.cleanup()
  }
})

test('mind 事件流：label 判不出就给 kind 原文，不凭空造', async () => {
  const ctx = await fixture()
  try {
    await ctx.engine.addLoop({ text: '正常开环', type: 'forming-intent' })
    await ctx.engine.closeLoop('L-1', { reason: '已定', by: 'mind' })
    await ctx.engine.queue
    // 账本是真相：直接追加一条缺 loopId 的 close 记录（回放容错路径），推导层必须退回 kind 原文。
    await appendFile(
      join(ctx.dir, 'loops.jsonl'),
      `${JSON.stringify({ op: 'close', by: 'mind', at: T0 + 99, reason: 'legacy' })}\n`,
      'utf8',
    )
    const rows = collectMindRows(ctx.dir, null)
    const fallback = rows.find((row) => row.at === T0 + 99)
    assert.ok(fallback !== undefined, '缺 id 的记录仍在（at 可判定）')
    assert.equal(fallback.kind, 'loop.close')
    assert.equal(fallback.label, 'loop.close', '判不出对象 id 就给 kind 原文')
    assert.equal(fallback.id, '')
    // at 也判不出的记录直接丢弃，不造时间。
    await appendFile(join(ctx.dir, 'briefings.jsonl'), `${JSON.stringify({ kind: 'overnight', text: '没有时间戳的更新' })}\n`, 'utf8')
    const rows2 = collectMindRows(ctx.dir, null)
    assert.equal(rows2.some((row) => row.label === '补隔夜更新' && row.at === undefined), false)
    assert.equal(rows2.length, rows.length, '无 at 的简报记录不进流')
  } finally {
    await ctx.cleanup()
  }
})

test('mind 事件流：快照 graph.mindEvents 与工作区共享事实口径', async () => {
  // 共享事实账本：workspace scope 的 fact 记录落在 shared/facts.jsonl，同源口径照收。
  const root = await mkdtemp(join(tmpdir(), 'miopiik-mind-ws-'))
  const dir = join(root, 'sessions', 'session-1')
  const store = await openStore(dir, 'session-1', { workspaceRoot: root })
  let clock = T0
  const engine = new Engine({ store, sessionId: 'session-1', now: () => clock })
  try {
    await engine.addFact({ claim: '用户说：跨会话也要记得', provenance: ['U-1'], source: 'user', scope: 'workspace' })
    clock += 1000
    await engine.addFact({ claim: '后台推断的共享结论', provenance: ['compile'], scope: 'workspace' })
    await engine.queue
    const rows = engine.backstageSnapshot().graph.mindEvents
    assert.equal(rows.length, 1, '共享账本里只有 source=user 的那条是 Mind 手笔')
    assert.equal(rows[0].kind, 'fact.add')
    assert.equal(rows[0].id, 'F-1')
    assert.equal(rows[0].label, '立事实 F-1')
    // 快照与直读同源：graph.mindEvents 就是 collectMindRows 的结果。
    assert.deepEqual(rows, collectMindRows(dir, store.shared?.path ?? null))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('mind 事件流：三视图消费的投影键不漂移（graph.mindEvents 在 graph 载荷里）', async () => {
  const ctx = await fixture()
  try {
    await ctx.engine.addLoop({ text: '投影键守卫', type: 'forming-intent' })
    await ctx.engine.queue
    const graph = ctx.engine.backstageSnapshot().graph
    assert.ok(Array.isArray(graph.mindEvents), 'graph.mindEvents 是数组')
    assert.equal(graph.mindEvents.length > 0, true)
    // 既有键一个不少：新增只增字段，不改旧字段语义。
    for (const key of ['turns', 'turnsTotal', 'turnsTruncated', 'events', 'branches', 'links', 'counts']) {
      assert.ok(Object.prototype.hasOwnProperty.call(graph, key), `graph.${key} 应保留`)
    }
  } finally {
    await ctx.cleanup()
  }
})
