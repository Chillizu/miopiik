import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openStore } from '../host/store.js'
import { Engine } from '../host/engine.js'
import { contentHash, extractEntities, searchIndex } from '../host/details.js'
import { DEFAULTS } from '../host/config-defaults.js'

const DAY = 24 * 60 * 60 * 1000
let clock = Date.now()

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'miopiik-details-'))
  const store = await openStore(dir, 's1')
  const engine = new Engine({ store, sessionId: 's1', now: () => clock })
  return { dir, engine, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('hash 去重：同样内容同一份文件、同一个 hash', async () => {
  const ctx = await fixture()
  try {
    const a = await ctx.engine.storeDetail({ text: '同一段内容' })
    const b = await ctx.engine.storeDetail({ text: '同一段内容' })
    assert.equal(a.hash, b.hash)
    assert.equal(contentHash('同一段内容'), a.hash)
    const files = await readdir(join(ctx.dir, 'details'))
    assert.equal(files.length, 1, '同内容只落一份')
  } finally {
    await ctx.cleanup()
  }
})

test('实体抽取：反引号标识符、文件路径、大写缩写', () => {
  const entities = extractEntities('改了 `ink_branch` 与 src/host/fold.js，涉及 SPEC 与 DSH')
  assert.ok(entities.includes('ink_branch'))
  assert.ok(entities.includes('src/host/fold.js'))
  assert.ok(entities.includes('SPEC'))
})

test('检索：按关键词、实体、开环、分支、天数过滤', async () => {
  const ctx = await fixture()
  try {
    await ctx.engine.storeDetail({ text: '竞品首页都在打防御定价，证据见 `F-2`', loops: ['L-3'], branch: 'B-1' })
    clock += DAY
    await ctx.engine.storeDetail({ text: '另一个话题：设置页的可调项', loops: ['L-9'] })

    assert.equal(ctx.engine.recall({ query: '竞品' }).length, 1)
    assert.equal(ctx.engine.recall({ entity: 'F-2' }).length, 1)
    assert.equal(ctx.engine.recall({ loop: 'L-9' }).length, 1)
    assert.equal(ctx.engine.recall({ branch: 'B-1' }).length, 1)
    assert.equal(ctx.engine.recall({ query: '竞品', loop: 'L-9' }).length, 0, '条件是与关系')
  } finally {
    await ctx.cleanup()
  }
})

test('长详情转指针：note 里只留预览，全文按 hash 读回', async () => {
  const ctx = await fixture()
  try {
    const loop = await ctx.engine.addLoop({ text: '一个悬着的事', type: 'promise' })
    const long = '这是一段很长的证据。'.repeat(400)
    const note = await ctx.engine.deliverNote({
      kind: 'preview',
      claim: '一条结论',
      why: 'compile:operator-result',
      refs: [loop.id],
      loops: [loop.id],
      question: '要不要看？',
      conf: 'mid',
      detail: long,
    })
    assert.ok(typeof note.detailRef === 'string' && note.detailRef.length > 0, 'note 应带指针')
    assert.ok(note.detail.length <= 130, 'note 里只留预览')
    assert.equal(await ctx.engine.readDetailText(note.detailRef), long)
  } finally {
    await ctx.cleanup()
  }
})

test('回收：只删没被引用且过期的；有引用的永远留着', async () => {
  const ctx = await fixture()
  try {
    const loop = await ctx.engine.addLoop({ text: '悬着', type: 'promise' })
    const long = '证据'.repeat(2000)
    const note = await ctx.engine.deliverNote({
      kind: 'preview',
      claim: '被引用的详情',
      why: 'compile:operator-result',
      refs: [loop.id],
      loops: [loop.id],
      question: '看吗？',
      detail: long,
    })
    const orphan = await ctx.engine.storeDetail({ text: '没人引用的旧材料'.repeat(200) })

    clock += 40 * DAY
    const result = await ctx.engine.gcDetails({ retentionDays: 30 })
    assert.ok(result.deleted.includes(orphan.hash), '孤儿且过期应被回收')
    assert.ok(!result.deleted.includes(note.detailRef), '被 note 引用的不回收')
    assert.equal(await ctx.engine.readDetailText(note.detailRef), long)
  } finally {
    await ctx.cleanup()
  }
})

test('工作区级事实：另一个会话写的事实，新会话打开就能用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'miopiik-shared-'))
  try {
    const s1 = await openStore(dir, 'session-a')
    const e1 = new Engine({ store: s1, sessionId: 'session-a' })
    const fact = await e1.addFact({ claim: '本地模型用 llmctl 管理', provenance: ['环境'], source: 'user', scope: 'workspace' })
    assert.equal(fact.id, 'F-1')

    // 另一个会话（同一个工作区目录）
    const s2 = await openStore(dir, 'session-b')
    const e2 = new Engine({ store: s2, sessionId: 'session-b' })
    const claims = e2.listFacts().map((entry) => entry.claim)
    assert.ok(claims.includes('本地模型用 llmctl 管理'), '共享事实应被另一个会话读到')
    assert.equal(s2.shared.state.facts.size, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('工作区级事实：修订与失效同样共享，不产生第二份', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'miopiik-shared-'))
  try {
    const e1 = new Engine({ store: await openStore(dir, 'a'), sessionId: 'a' })
    const fact = await e1.addFact({ claim: '旧结论', provenance: ['x'], source: 'ink', scope: 'workspace' })
    await e1.reviseFact(fact.id, { claim: '新结论' })
    await e1.invalidateFact(fact.id, '已被推翻')

    const e2 = new Engine({ store: await openStore(dir, 'b'), sessionId: 'b' })
    const list = e2.listFacts()
    assert.equal(list.length, 0, '失效的事实不该出现在工作记忆里')
    assert.equal(e2.state.facts.get(fact.id).claim, '新结论')
    assert.equal(e2.state.facts.get(fact.id).stale, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('念旧：一个入口能查到 note、观测原文、分支与事实，而不只是详情仓', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'miopiik-recall-'))
  try {
    const engine = new Engine({ store: await openStore(dir, 'a'), sessionId: 'a' })
    engine.observe({
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我们讨论过鱼骨图的实现方式' }] },
    })
    await engine.queue
    const branch = await engine.openBranch({ label: '鱼骨渲染', summary: '把分支画成图', premise: '需要一个主视图' })
    await engine.addFact({ claim: '鱼骨图放在会话视图里', provenance: ['用户'], source: 'user' })
    await engine.deliverNote({
      kind: 'preview',
      claim: '鱼骨改成横泳道',
      why: 'design',
      refs: [branch.id],
      branch: branch.id,
      loops: [],
      question: '要不要再调？',
      detail: null,
    })

    const byQuery = engine.recall({ query: '鱼骨' })
    const kinds = new Set(byQuery.map((hit) => hit.kind))
    assert.ok(kinds.has('utterance'), '应能查到观测原文')
    assert.ok(kinds.has('branch'), '应能查到分支')
    assert.ok(kinds.has('fact'), '应能查到事实')

    const byBranch = engine.recall({ branch: branch.id })
    assert.ok(byBranch.some((hit) => hit.kind === 'branch'))
    assert.ok(byBranch.some((hit) => hit.kind === 'note'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('开分支时就带上前提与引用，当场落库', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'miopiik-branchctx-'))
  try {
    const engine = new Engine({ store: await openStore(dir, 'a'), sessionId: 'a' })
    const branch = await engine.openBranch({
      label: '竞品',
      summary: '看竞品',
      premise: '用户怀疑竞品在防御定价',
      quotes: ['“他们其实是在防御”'],
    })
    assert.equal(branch.context.premise, '用户怀疑竞品在防御定价')
    assert.deepEqual(branch.context.quotes, ['“他们其实是在防御”'])
    const slice = engine.branchSlice(branch.id).text
    assert.match(slice, /前提.*用户怀疑竞品在防御定价/)
    assert.match(slice, /他们其实是在防御/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('工作区级事实：修订与失效当场在本会话可见（不等到重启）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'miopiik-shared-sync-'))
  try {
    const engine = new Engine({ store: await openStore(dir, 'a'), sessionId: 'a' })
    const fact = await engine.addFact({ claim: '旧说法', provenance: ['x'], source: 'user' })
    const revised = await engine.reviseFact(fact.id, { claim: '新说法' })
    assert.equal(revised.claim, '新说法')
    assert.equal(engine.listFacts()[0].claim, '新说法')
    await engine.invalidateFact(fact.id, '不再成立')
    assert.equal(engine.listFacts().length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('账本按会话隔离，只有事实卡跨会话共享', async () => {
  const root = await mkdtemp(join(tmpdir(), 'miopiik-split-'))
  try {
    const dirA = join(root, 'sessions', 'a')
    const dirB = join(root, 'sessions', 'b')
    const a = new Engine({ store: await openStore(dirA, 'a', { workspaceRoot: root }), sessionId: 'a' })
    const b = new Engine({ store: await openStore(dirB, 'b', { workspaceRoot: root }), sessionId: 'b' })

    await a.addLoop({ text: 'A 会话的线索', type: 'promise' })
    const privateFact = await a.addFact({ claim: '只属于 A 的临时结论', provenance: ['A'], source: 'ink' })
    const sharedFact = await a.addFact({ claim: '两边都该知道的结论', provenance: ['A'], source: 'user', scope: 'workspace' })
    assert.equal(privateFact.scope, 'session', '默认会话级')
    assert.equal(sharedFact.scope, 'workspace')

    assert.equal(b.listLoops().length, 0, 'B 不该看到 A 的开环')
    const seen = b.listFacts().map((fact) => fact.claim)
    assert.ok(seen.includes('两边都该知道的结论'), 'workspace 作用域的事实应共享')
    assert.ok(!seen.includes('只属于 A 的临时结论'), '默认作用域的事实不该泄漏到别的会话')

    const bBranch = await b.openBranch({ label: 'B 的分支', forkedAtTurn: 1 })
    assert.equal(a.listBranches().length, 0, 'A 不该看到 B 的分支')
    assert.equal(b.listBranches()[0].id, bBranch.id)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('旧布局不再自动认领：留空并交给 tools/adopt-legacy.mjs 按时间戳归还', async () => {
  const root = await mkdtemp(join(tmpdir(), 'miopiik-migrate-'))
  try {
    await appendFile(join(root, 'observations.jsonl'), JSON.stringify({ seq: 1, at: 1, day: 1, turn: 1, kind: 'user', text: '旧数据' }) + '\n')
    await appendFile(join(root, 'branches.jsonl'), JSON.stringify({ op: 'create', branch: { id: 'B-1', label: '旧分支', createdAt: 1 } }) + '\n')

    const sessionDir = join(root, 'sessions', 's1')
    const engine = new Engine({ store: await openStore(sessionDir, 's1', { workspaceRoot: root }), sessionId: 's1' })
    // 关键：不猜、不硬塞。别人的分支不该出现在这个会话里。
    assert.equal(engine.listBranches().length, 0, '旧账本不该被自动塞进当前会话')
    assert.ok(existsSync(join(root, 'branches.jsonl')), '旧文件应原样保留，等认领工具处理')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('事实卡不设条数上限，但会算重量并指出疑似重复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'miopiik-factstat-'))
  try {
    const engine = new Engine({ store: await openStore(join(root, 'sessions', 'a'), 'a', { workspaceRoot: root }), sessionId: 'a' })
    // 超过 40 条也不再拒收（上限已取消）
    for (let index = 0; index < 45; index += 1) {
      await engine.addFact({ claim: `互不相同的结论 ${index}`, provenance: ['测试'], source: 'ink' })
    }
    assert.equal(engine.listFacts().length, 45)

    const stats = engine.factStats()
    assert.equal(stats.active, 45)
    assert.ok(stats.bytes > 0, '应统计字节数')
    assert.equal(stats.recent, 45)

    // 写一条与已有结论高度相似的，应在返回里指出
    const added = await engine.addFact({ claim: '互不相同的结论 7', provenance: ['测试'], source: 'ink' })
    assert.ok(added.similar.length > 0, '相似结论应被指出来')
    assert.ok(added.similar[0].score >= 0.6)

    // L3 只有超过 8 条才显示重量，且带疑似重复提示
    const l3 = engine.l3Text()
    assert.match(l3, /已定结论：\d+ 条 \/ [\d.]+ KB/)
    assert.match(l3, /疑似重复/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('中间层的连续上下文：回合结束后追加，且在队列内不会自锁', async () => {
  const root = await mkdtemp(join(tmpdir(), 'miopiik-inkctx-'))
  try {
    const engine = new Engine({ store: await openStore(join(root, 'sessions', 'a'), 'a', { workspaceRoot: root }), sessionId: 'a' })
    engine.observe({ type: 'turn/start', data: { turn: 1 } })
    engine.observe({
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一轮用户的话' }] },
    })
    engine.observe({
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: '第一轮我的回答' }] } },
    })
    // finishTurn 在队列里跑：这里若再入队就会自锁，所以给一个超时断言。
    await Promise.race([
      engine.observe({ type: 'turn/end', data: { turn: 1 } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('turn/end 自锁了')), 2000)),
    ])
    await engine.queue
    assert.match(engine.inkContext(), /第一轮用户的话/)
    assert.match(engine.inkContext(), /第一轮我的回答/)
    assert.ok(engine.state.inkTail.length >= 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
