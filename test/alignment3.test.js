import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openStore } from '../host/store.js'
import { Engine } from '../host/engine.js'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 10, 1, 10, 0, 0)

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'miopiik-align3-'))
  const store = await openStore(dir, 'session-1')
  let clock = T0
  const engine = new Engine({ store, sessionId: 'session-1', now: () => clock })
  return {
    dir,
    engine,
    advance(ms) {
      clock += ms
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('决定也进它自己的上下文：note 落账后追加到 ink-context', async () => {
  const ctx = await fixture()
  try {
    await ctx.engine.deliverNote({ kind: 'absorb', claim: '这轮没有需要动的事', why: 'no-signal', conf: 'low', refs: [] })
    await ctx.engine.queue
    const entry = ctx.engine.state.inkTail.at(-1)
    assert.equal(entry.kind, 'note')
    assert.match(entry.text, /absorb｜这轮没有需要动的事/)
    assert.deepEqual(entry.refs, ['D-1'])
  } finally {
    await ctx.cleanup()
  }
})

test('折叠由事件触发：epoch 前进就折，不看条数', async () => {
  const ctx = await fixture()
  try {
    for (const index of [1, 2, 3]) {
      await ctx.engine.appendInkContext({ kind: 'user', text: `第 ${index} 句话`, refs: [`U-${index}`] })
    }
    assert.equal(ctx.engine.state.inkTail.length, 3, '三条不该触发折叠（上限 24）')
    await ctx.engine.advanceEpoch({ note: '换话题' })
    assert.equal(ctx.engine.state.inkTail.length, 0)
    assert.ok(ctx.engine.state.inkHead.includes('第 1 句话'))
    const rows = (await readFile(join(ctx.dir, 'ink-context.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const fold = rows.filter((row) => row.op === 'fold').at(-1)
    assert.equal(fold.reason, 'epoch')
  } finally {
    await ctx.cleanup()
  }
})

test('开工时星标被带上来（L3 里出现）', async () => {
  const ctx = await fixture()
  try {
    await ctx.engine.deliverNote({
      kind: 'preview',
      claim: '这件事值得回来看',
      question: '要不要现在接回？',
      why: 'test',
      conf: 'mid',
      refs: ['L-1'],
      loops: ['L-1'],
    })
    const itemId = [...ctx.engine.state.inbox.keys()][0]
    await ctx.engine.markInbox(itemId, 'star')
    await ctx.engine.saveBriefing({ progress: '推进了一件事', next: '明天接着看' })
    ctx.advance(DAY)
    const text = ctx.engine.l3Text()
    assert.match(text, /星标（跨天带上来）：1 条/)
    assert.match(text, /这件事值得回来看/)
  } finally {
    await ctx.cleanup()
  }
})

test('后台快照带上 Ink 上下文与候选（所见视图的数据面）', async () => {
  const ctx = await fixture()
  try {
    await ctx.engine.appendInkContext({ kind: 'user', text: '一句话', refs: ['U-1'] })
    await ctx.engine.deliverNote({ kind: 'absorb', claim: '看过了', why: 'no-signal', conf: 'low', refs: [] })
    const snapshot = ctx.engine.backstageSnapshot()
    assert.ok(typeof snapshot.inkContext.head === 'string')
    assert.equal(snapshot.inkContext.tail.length, 2, '用户话 + 决定都应出现在尾部')
    assert.ok(['note', 'user'].includes(snapshot.inkContext.tail[0].kind))
    assert.ok(Array.isArray(snapshot.candidates))
  } finally {
    await ctx.cleanup()
  }
})

test('折叠按整行截断并去掉连续重复行', async () => {
  const ctx = await fixture()
  try {
    await ctx.engine.appendInkContext({ kind: 'user', text: '同一句话', refs: ['U-1'] })
    await ctx.engine.appendInkContext({ kind: 'assistant', text: '一条很长的回复'.repeat(200), refs: [] })
    await ctx.engine.advanceEpoch({ note: '换话题' })
    const head = ctx.engine.state.inkHead
    assert.ok(head.length <= 2000)
    assert.ok(!head.startsWith(' '), '头部应从行首开始，不该停在半句话')
    assert.ok(head.includes('- [user] 同一句话'))
  } finally {
    await ctx.cleanup()
  }
})

test('收工回合不会自锁：closing-signal 落账、上下文按 closing 折叠', async () => {
  const ctx = await fixture()
  try {
    ctx.engine.observe({ type: 'turn/start', data: { turn: 1 } })
    ctx.engine.observe({
      type: 'user/message',
      data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: '先这样' }] },
    })
    ctx.engine.observe({
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: '好' }] } },
    })
    await Promise.race([
      ctx.engine.observe({ type: 'turn/end', data: { turn: 1 } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('收工自锁了')), 2000)),
    ])
    await ctx.engine.queue
    assert.ok(ctx.engine.state.briefings.some((record) => record.kind === 'closing-signal'))
    const rows = (await readFile(join(ctx.dir, 'ink-context.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.ok(rows.some((row) => row.op === 'fold' && row.reason === 'closing'))
  } finally {
    await ctx.cleanup()
  }
})

test('无人值守判定：本轮没有真人的话就不算', async () => {
  const ctx = await fixture()
  try {
    ctx.engine.observe({ type: 'turn/start', data: { turn: 2 } })
    assert.equal(ctx.engine.hadUserInputThisTurn(), false, '自动续跑的回合没有用户输入')
    ctx.engine.observe({ type: 'user/message', data: { turn: 2, source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } })
    await ctx.engine.queue
    assert.equal(ctx.engine.hadUserInputThisTurn(), true)
  } finally {
    await ctx.cleanup()
  }
})
