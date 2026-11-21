import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openStore } from '../host/store.js'
import { Engine } from '../host/engine.js'
import { dayOf } from '../host/loops.js'
import { parseBackstageCommand, registerBackstageCommand } from '../host/commands.js'
import { collectAuditRows, auditPage } from '../host/audit.js'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 10, 1, 10, 0, 0)

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'miopiik-audit-'))
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

/** 往账本里铺一层覆盖所有可重建操作的事件（跨三天）。 */
async function seedLedger(ctx) {
  const { engine } = ctx
  // 第 0 天：登记、开卡、分支、任务、草稿、收件箱、简报、epoch、折叠
  await engine.observe({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我看一下后台账本' }] } })
  await engine.addLoop({ text: '流水通道还没定', type: 'forming-intent', closureCondition: '按天翻页走通' })
  await engine.addFact({ claim: '账本是 append-only JSONL', provenance: ['SPEC §2.2'], conf: 'high' })
  await engine.addFact({ claim: '共享结论要跨会话可见', provenance: ['SPEC §2.3'], conf: 'mid', scope: 'workspace' })
  const branch = await engine.openBranch({ label: '取数通道验证', summary: '验证 audit 通道', facts: ['F-1'] })
  await engine.deliverNote({ kind: 'absorb', claim: '这轮看的是账本本身', why: 'no-signal', conf: 'low', refs: [] })
  await engine.deliverNote({ kind: 'answer', claim: '答复：账本可肉眼审计', why: 'cite:fact', refs: ['F-1'], conf: 'high' })
  const preview = await engine.deliverNote({
    kind: 'preview',
    claim: '「流水通道还没定」有了新进展',
    why: 'compile:conversation',
    question: '要不要现在接上流水通道？',
    refs: ['L-1'],
    loops: ['L-1'],
  })
  const itemId = [...engine.state.inbox.keys()][0]
  await engine.addJob({ id: 'J-1', label: '探测命令通道', branchId: branch.id, state: 'running', startedAt: ctx.engine.now(), loopId: 'L-1' })
  await engine.updateJob('J-1', { state: 'failed', endedAt: engine.now(), stopReason: 'start-failed' })
  const draft = await engine.addDraft({ title: '取数通道设计', summary: 'audit 命令装 JSON' })
  await engine.settleDraft(draft.id, { status: 'committed', reason: 'gate:approved' })
  await engine.markInbox(itemId, 'read')
  await engine.saveBriefing({ progress: '账本铺完了', loops: 'L-1 在追', running: 'J-1 失败', drafts: '', next: '翻页测试' })
  await engine.advanceEpoch({ note: '换到通道验证' })
  // 折叠验收判据：活跃开环要么写进档案、要么先闭合——档案里显式带上 L-1 的原文。
  const fold = await engine.proposeFold({
    archive: '用户：帮我看一下后台账本\n我：流水通道还没定，闭合条件是按天翻页走通',
  })
  await engine.settleFold(fold.id, { approve: true })
  await engine.queue

  // 第 1 天：第二条线、共享事实交汇、合并/丢弃、隔夜更新
  ctx.advance(DAY)
  // 这天要有真人的话但没写主体简报：给第 2 天的 hard-break 检测留断点。
  await engine.observe({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二天接着看线间关系' }] } })
  await engine.addLoop({ text: '命令返回体积要封顶', type: 'pending-option' })
  await engine.closeLoop('L-2', { reason: '上限定了 200', by: 'mind' })
  const dropped = await engine.addLoop({ text: '不需要的第二条', type: 'forming-intent' })
  await engine.dropLoop(dropped.id, { reason: '不需要', by: 'mind' })
  await engine.addFact({ claim: '命令通道每次落两条 log-only 事件', provenance: ['dsh-commands'], conf: 'mid' })
  await engine.reviseFact('F-1', { claim: '账本是 append-only JSONL（回放即真相）' })
  await engine.openBranch({ label: '线间关系验证', summary: '与 B-1 共享 F-1', facts: ['F-1', 'F-2'] })
  await engine.deliverNote(
    { kind: 'hold', claim: '后台问了一件事，手上没有可引用的答案', why: 'no-citation', refs: [], conf: 'low', question: '要不要现在定一下：返回体积上限？' },
    { blocking: true },
  )
  await engine.deliverNote({ kind: 'escalate', claim: '有一处必须上报：通道选型还没拍板', why: 'no-citation', refs: ['L-1'], conf: 'low' })
  await engine.deliverNote({ kind: 'verify', claim: '验证过：命令通道可达', why: 'cite:fact', refs: ['F-1'], conf: 'mid', detail: '证据：client.js 走 remote.commands.execute' })
  const holdId = [...engine.state.inbox.keys()].at(-1)
  await engine.markInbox(holdId, 'defer')
  await engine.appendBriefingUpdate('夜里补了一条：limit 上限定 200')
  await engine.mergeBranch('B-1', { claim: '取数通道验证有结论了' })
  await engine.abandonBranch('B-2', { reason: '验证完毕' })
  await engine.invalidateFact('F-3', '被对话新结论取代')
  await engine.queue

  // 第 2 天：跨天断点（hard-break + 盘外素材）
  ctx.advance(DAY)
  await engine.detectGap()
  await engine.queue
}

const ROW_KEYS = new Set(['id', 'at', 'day', 'kind', 'actor', 'claim', 'refs', 'branch', 'detail'])

test('auditPage：统一行形状，覆盖账本全部可重建操作', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    const page = ctx.engine.auditPage({ limit: 200 })
    assert.ok(page.rows.length > 30, `账本该有几十条操作行，实际 ${page.rows.length}`)
    for (const row of page.rows) {
      for (const key of Object.keys(row)) assert.ok(ROW_KEYS.has(key), `多出来的字段: ${key}`)
      assert.equal(typeof row.id, 'string')
      assert.equal(typeof row.kind, 'string')
      assert.equal(typeof row.actor, 'string')
      assert.equal(typeof row.claim, 'string')
      assert.ok(Array.isArray(row.refs))
      assert.ok(Number.isFinite(row.at))
      assert.equal(row.day, dayOf(row.at), 'day 必须由 at 推出，不能另造')
    }
    const kinds = new Set(page.rows.map((row) => row.kind))
    for (const expected of [
      'absorb', 'answer', 'preview', 'hold', 'escalate', 'verify', // note 子类
      'fact.add', 'fact.revise', 'fact.invalidate',
      'loop.add', 'loop.close', 'loop.drop',
      'branch.fork', 'branch.merge', 'branch.abandon', 'branch.context',
      'job.dispatch', 'job.update',
      'draft.add', 'draft.settle',
      'inbox.deliver', 'inbox.read', 'inbox.defer',
      'epoch', 'briefing', 'briefing.overnight', 'briefing.hard-break', 'briefing.auto-materials',
      'fold.propose', 'fold.apply',
    ]) {
      assert.ok(kinds.has(expected), `流水里该有 ${expected}，实际只有：${[...kinds].join('、')}`)
    }
    // note 行带完整 claim；job 状态迁移带 stopReason；工作区事实行带 scope 标注。
    const absorb = page.rows.find((row) => row.kind === 'absorb')
    assert.equal(absorb.actor, 'ink')
    assert.match(absorb.claim, /账本本身/)
    const jobUpdate = page.rows.find((row) => row.kind === 'job.update')
    assert.match(jobUpdate.detail, /stopReason: start-failed/)
    const shared = page.rows.find((row) => row.kind === 'fact.add' && row.detail?.includes('workspace'))
    assert.ok(shared, '工作区共享事实的操作行也要进流水')
  } finally {
    await ctx.cleanup()
  }
})

test('auditPage：无缺口从最新翻到最早（before 游标全量走一遍）', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    const full = ctx.engine.auditPage({ limit: 200 }).rows
    assert.ok(full.length < 200, '夹具行数要低于单页上限，这页才是全集')

    const walked = []
    let cursor = null
    do {
      const page = cursor === null
        ? ctx.engine.auditPage({ limit: 5 })
        : ctx.engine.auditPage({ before: cursor.before, beforeSeq: cursor.beforeSeq, limit: 5 })
      walked.push(...page.rows)
      cursor = page.nextCursor
    } while (cursor !== null)
    assert.deepEqual(walked, full, '按页翻完要等于一次取全，不多不少（同毫秒并列也不漏不重）')
    assert.ok(full[0].at >= full[full.length - 1].at, '第一行最新，最后一行最早')
  } finally {
    await ctx.cleanup()
  }
})

test('auditPage：按天翻页，当天翻不完用同日游标续翻', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    const day0 = dayOf(T0)
    const day1 = dayOf(T0 + DAY)
    const day2 = dayOf(T0 + 2 * DAY)
    const full = ctx.engine.auditPage({ limit: 200 }).rows

    // 第 2 天翻完 → 游标跳回第 1 天；第 1 天翻完 → 跳回第 0 天；第 0 天翻完 → 空。
    let day = day2
    const byDay = []
    let expectDay = [day2, day1, day0]
    for (const expected of expectDay) {
      const page = ctx.engine.auditPage({ day, limit: 200 })
      assert.ok(page.rows.length > 0, `第 ${day} 天该有行`)
      assert.ok(page.rows.every((row) => row.day === expected))
      byDay.push(...page.rows)
      day = page.nextCursor?.day ?? null
    }
    assert.equal(day, null, '最早一天翻完，游标该是空')
    assert.deepEqual([...byDay].sort((a, b) => b.at - a.at), full, '按天走完全部 = 一次取全')

    // 第 0 天行数 > limit：nextCursor 带同日 before 游标。
    const dayRows = full.filter((row) => row.day === day0)
    assert.ok(dayRows.length > 3, `第 0 天要多于 3 行才能测同日续翻（实际 ${dayRows.length}）`)
    const page1 = ctx.engine.auditPage({ day: day0, limit: 3 })
    assert.equal(page1.rows.length, 3)
    assert.equal(page1.nextCursor.day, day0)
    assert.ok(Number.isFinite(page1.nextCursor.before))
    const page2 = ctx.engine.auditPage({ day: day0, limit: 3, before: page1.nextCursor.before, beforeSeq: page1.nextCursor.beforeSeq })
    assert.equal(page2.rows.length, 3)
    assert.deepEqual([...page1.rows, ...page2.rows], dayRows.slice(0, 6), '同日续翻接着上一页的末行')
  } finally {
    await ctx.cleanup()
  }
})

test('auditPage：kind 与 branch 过滤器', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    const facts = ctx.engine.auditPage({ kind: 'fact.add', limit: 200 }).rows
    assert.ok(facts.length >= 3)
    assert.ok(facts.every((row) => row.kind === 'fact.add'))
    const branchRows = ctx.engine.auditPage({ branch: 'B-1', limit: 200 }).rows
    assert.ok(branchRows.length > 0)
    assert.ok(branchRows.every((row) => row.branch === 'B-1'))
    const fork = branchRows.find((row) => row.kind === 'branch.fork')
    assert.equal(fork.id, 'B-1')
    // 过滤后无行：游标为空而不是凭空造行。
    const empty = ctx.engine.auditPage({ kind: 'fact.add', branch: 'B-9' })
    assert.deepEqual(empty, { rows: [], nextCursor: null })
  } finally {
    await ctx.cleanup()
  }
})

test('取数通道往返：/miopiik audit 命令注册 → execute → JSON 解析 → 游标续翻', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    // 语法
    assert.deepEqual(parseBackstageCommand('audit'), { kind: 'audit', query: {} })
    assert.deepEqual(parseBackstageCommand('audit page day=20778 limit=5'), { kind: 'audit', query: { day: 20778, limit: 5 } })
    assert.deepEqual(parseBackstageCommand('  audit before=123 beforeSeq=9 kind=fold.apply '), {
      kind: 'audit',
      query: { before: 123, beforeSeq: 9, kind: 'fold.apply' },
    })
    assert.match(parseBackstageCommand('audit foo=1').error, /未知 audit 参数/)
    assert.match(parseBackstageCommand('audit day=abc').error, /要是数字/)
    assert.match(parseBackstageCommand('audit day').error, /key=value/)
    // 原有干预语法不受影响
    assert.deepEqual(parseBackstageCommand('loop close L-1'), { kind: 'loop', op: 'close', id: 'L-1' })

    // 注册（假 ctx 只提供 commands 服务），再模拟浏览器端的 execute 调用。
    const registered = []
    const fakeCtx = {
      get: (name) => (name === 'commands' ? { register: (definition) => registered.push(definition) } : undefined),
      effect: (fn) => fn(),
    }
    const engines = new Map([['session-1', ctx.engine]])
    registerBackstageCommand(fakeCtx, engines)
    assert.equal(registered.length, 1)
    const command = registered[0]
    assert.equal(command.name, 'miopiik')
    assert.equal(command.recordInput, false, '查询参数不能留在会话日志里')

    const runCommand = async (line) => {
      const outcome = await command.handler({ agent: { session: { id: 'session-1' } }, rawInput: line })
      assert.equal(outcome.kind, 'success')
      return JSON.parse(outcome.text)
    }
    // 全量翻页：游标 JSON → 命令行 → host → JSON → 再解析，走通即通道成立。
    const full = ctx.engine.auditPage({ limit: 200 }).rows
    const walked = []
    let line = 'audit limit=4'
    for (;;) {
      const page = await runCommand(line)
      walked.push(...page.rows)
      if (page.nextCursor === null) break
      const { before, beforeSeq } = page.nextCursor
      line = `audit before=${before} beforeSeq=${beforeSeq} limit=4`
    }
    assert.deepEqual(walked, full, '命令通道翻完 = 引擎直取全集')
    // 按天也走一遍
    const dayPage = await runCommand(`audit day=${dayOf(T0)} limit=3`)
    assert.ok(dayPage.rows.every((row) => row.day === dayOf(T0)))
    assert.ok(dayPage.nextCursor.day === dayOf(T0) || dayPage.nextCursor === null)
  } finally {
    await ctx.cleanup()
  }
})

test('graph：links 按分支事实交集计算，任务带 stopReason，主干有总数与截断标记', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    const graph = ctx.engine.backstageSnapshot().graph
    assert.deepEqual(
      graph.links,
      [{ kind: 'shared-fact', factId: 'F-1', between: ['B-1', 'B-2'] }],
      'B-1 与 B-2 共享 F-1，且只有这一条交集',
    )
    const jobEvent = graph.events.find((event) => event.kind === 'job' && event.jobId === 'J-1')
    assert.equal(jobEvent.stopReason, 'start-failed')
    const branchNode = graph.branches.find((node) => node.id === 'B-1')
    assert.equal(branchNode.jobs[0].stopReason, 'start-failed')
    // 现有形状零破坏：turns 仍是数组，新增字段只做加法。
    assert.ok(Array.isArray(graph.turns))
    assert.equal(graph.turns.length, Math.min(16, graph.turnsTotal))
    assert.equal(graph.turnsTotal, 1, '夹具里只有一轮有对话行')
    assert.equal(graph.turnsTruncated, false)
  } finally {
    await ctx.cleanup()
  }
})

test('graph：主干超过 16 轮时 turnsTotal/turnsTruncated 说真话', async () => {
  const ctx = await fixture()
  try {
    for (let turn = 1; turn <= 20; turn += 1) {
      ctx.engine.observe({ type: 'turn/start', data: { turn } })
      ctx.engine.observe({
        type: 'user/message',
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: `第 ${turn} 轮的话` }] },
      })
    }
    await ctx.engine.queue
    const graph = ctx.engine.backstageSnapshot().graph
    assert.equal(graph.turnsTotal, 20)
    assert.equal(graph.turnsTruncated, true)
    assert.equal(graph.turns.length, 16)
    assert.equal(graph.turns[0].turn, 5, '截断后保留最近 16 轮')
  } finally {
    await ctx.cleanup()
  }
})

test('l3：sections 与 text 同一次装配，快照与注入 Mind 的原文同文', async () => {
  const ctx = await fixture()
  try {
    await ctx.engine.addLoop({ text: '展示时机还没定', type: 'forming-intent', closureCondition: '定下展示规则' })
    await ctx.engine.addLoop({ text: '第二件事也在追', type: 'pending-option' })
    await ctx.engine.addFact({ claim: '结论甲：账本可回放', provenance: ['SPEC'], conf: 'high' })
    await ctx.engine.addFact({ claim: '结论乙：流水要全量', provenance: ['SPEC'], conf: 'mid' })
    await ctx.engine.deliverNote({
      kind: 'preview',
      claim: '「展示时机还没定」还没合上',
      why: 'aging',
      question: '要不要现在接着聊？',
      refs: ['L-1'],
      loops: ['L-1'],
    })
    await ctx.engine.queue

    const snapshot = ctx.engine.backstageSnapshot()
    const l3 = snapshot.l3
    assert.ok(l3.generatedAt >= T0)
    // 同文钉死：快照里的 text 就是 prompt.js 每轮注入的那段。
    assert.equal(l3.text, ctx.engine.l3Text())
    assert.match(l3.text, /## 后台（Ink）/)
    assert.ok(l3.text.length > 0)

    // 开环：计数行 === sections.loops 总数，且渲染出的前 5 条逐字在原文里。
    const active = Number(/悬着的事：活跃 (\d+) /u.exec(l3.text)?.[1])
    assert.equal(active, l3.sections.loops.length)
    for (const loop of l3.sections.loops.slice(0, 5)) {
      assert.ok(l3.text.includes(`- [${loop.id}] ${loop.text}`), `${loop.id} 的原文要在 text 里`)
    }
    // 收件箱：sections 是完整 claim/question，原文渲染的就是这几条。
    for (const item of l3.sections.inbox) {
      assert.ok(l3.text.includes(item.claim), '收件箱 section 的 claim 要在原文里')
      assert.ok(['T0', 'T1', 'T2', 'T3'].includes(item.tier))
    }
    // 事实（< 8 条）：原文渲染前 4 条，sections 带全部完整 claim。
    assert.ok(l3.sections.facts.length >= 2 && l3.sections.facts.length < 8)
    for (const fact of l3.sections.facts.slice(0, 4)) {
      assert.ok(l3.text.includes(`[${fact.id}] ${fact.claim}`), `${fact.id} 的 claim 要逐字进原文`)
    }
    assert.ok(l3.sections.facts.every((fact) => fact.claim.length > 0), 'facts 是全文不是计数')
  } finally {
    await ctx.cleanup()
  }
})

test('l3：事实超过 8 条走计数行，计数 === sections 全长', async () => {
  const ctx = await fixture()
  try {
    for (let index = 1; index <= 9; index += 1) {
      await ctx.engine.addFact({ claim: `结论${index}：用于撑过八条门槛`, provenance: ['test'], conf: 'low' })
    }
    await ctx.engine.queue
    const l3 = ctx.engine.backstageSnapshot().l3
    const counted = Number(/已定结论：(\d+) 条/u.exec(l3.text)?.[1])
    assert.equal(counted, l3.sections.facts.length, '计数行的数字就是 sections 的全长，不能各说各话')
    assert.equal(l3.sections.facts.length, 9)
    assert.ok(l3.sections.facts.every((fact) => fact.claim.length > 0))
  } finally {
    await ctx.cleanup()
  }
})

test('collectAuditRows：磁盘文件就是真相，内存状态没看到的行也读得到', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    // 最后一刻绕过引擎直接落一行（模拟另一进程的追加），audit 现读文件就能看见。
    const { appendFile } = await import('node:fs/promises')
    await appendFile(join(ctx.dir, 'loops.jsonl'), `${JSON.stringify({ op: 'drop', loopId: 'L-1', at: T0 + 3 * DAY, by: 'user', reason: 'intervention:ui' })}\n`)
    const rows = collectAuditRows(ctx.dir, ctx.store.shared.path)
    const dropped = rows.find((row) => row.kind === 'loop.drop' && row.id === 'L-1')
    assert.ok(dropped, '绕过内存直接落盘的行也能被流水读到')
    assert.equal(dropped.actor, 'user')
    assert.equal(dropped.day, dayOf(T0 + 3 * DAY))
    // 分页纯函数对空输入不炸
    assert.deepEqual(auditPage([], { limit: 10 }), { rows: [], nextCursor: null })
  } finally {
    await ctx.cleanup()
  }
})
