import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openStore } from '../miopiik-dsh/host/store.js'
import { Engine } from '../miopiik-dsh/host/engine.js'
import { contentHash, extractEntities, searchIndex } from '../miopiik-dsh/host/details.js'

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
    const fact = await e1.addFact({ claim: '本地模型用 llmctl 管理', provenance: ['环境'], source: 'user' })
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
    const fact = await e1.addFact({ claim: '旧结论', provenance: ['x'], source: 'ink' })
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
