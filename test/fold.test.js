import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openStore } from '../miopiik-dsh/host/store.js'
import { Engine } from '../miopiik-dsh/host/engine.js'
import { buildArchive, verifyProposal } from '../miopiik-dsh/host/fold.js'

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'miopiik-fold-'))
  const store = await openStore(dir, 's1')
  const engine = new Engine({ store, sessionId: 's1' })
  return { dir, engine, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('影子折叠：只建议，不替换任何东西', async () => {
  const ctx = await fixture()
  try {
    ctx.engine.observe({
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我们先把折叠做成两阶段' }] },
    })
    ctx.engine.observe({
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: '好，先出提案，你验收了再替换' }] } },
    })
    await ctx.engine.queue

    const proposal = await ctx.engine.proposeFold()
    assert.equal(proposal.status, 'pending')
    assert.match(proposal.archive, /用户：我们先把折叠做成两阶段/)
    assert.match(proposal.archive, /我：好，先出提案/)
    assert.equal(ctx.engine.pendingFold().id, proposal.id)
    assert.match(ctx.engine.l3Text(), /有一条折叠提案等你验收/)
  } finally {
    await ctx.cleanup()
  }
})

test('验收判据只有一条：折叠后每条活跃开环都还接得上', async () => {
  const ctx = await fixture()
  try {
    ctx.engine.observe({
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '先聊折叠' }] },
    })
    await ctx.engine.queue
    await ctx.engine.addLoop({ text: '设置页还没做', type: 'forming-intent' })

    const proposal = await ctx.engine.proposeFold()
    const review = ctx.engine.reviewFold(proposal.id)
    assert.ok(review.problems.some((line) => line.includes('设置页还没做')), '接不上的开环必须被指出来')
    await assert.rejects(() => ctx.engine.settleFold(proposal.id, { approve: true }), /还没接得上/)
  } finally {
    await ctx.cleanup()
  }
})

test('Mind 可以自己改写档案，通过后才替换并留下 appliedSeq', async () => {
  const ctx = await fixture()
  try {
    ctx.engine.observe({
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '聊了很多' }] },
    })
    await ctx.engine.queue
    const loop = await ctx.engine.addLoop({ text: '设置页还没做', type: 'forming-intent' })
    const proposal = await ctx.engine.proposeFold()

    const rewritten = `用户想先做折叠；设置页（${loop.id}）仍悬着，回头接着做。`
    const result = await ctx.engine.settleFold(proposal.id, { approve: true, archive: rewritten })
    assert.equal(result.proposal.status, 'applied')
    assert.equal(result.proposal.archive, rewritten)
    assert.equal(result.proposal.settledBy, 'mind')
    assert.equal(ctx.engine.pendingFold(), null)
    assert.doesNotMatch(ctx.engine.l3Text(), /折叠提案等你验收/)
  } finally {
    await ctx.cleanup()
  }
})

test('退回：记下理由，提案不能重复处理', async () => {
  const ctx = await fixture()
  try {
    ctx.engine.observe({
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '先这样' }] },
    })
    await ctx.engine.queue
    const proposal = await ctx.engine.proposeFold()
    const rejected = await ctx.engine.settleFold(proposal.id, { approve: false, reason: '接不上' })
    assert.equal(rejected.proposal.status, 'rejected')
    assert.equal(rejected.applied, false)
    await assert.rejects(() => ctx.engine.settleFold(proposal.id, { approve: false }), /已经处理过/)
  } finally {
    await ctx.cleanup()
  }
})

test('机械档案有上限，且只收用户与我的最终话', () => {
  const observations = []
  for (let index = 0; index < 100; index += 1) {
    observations.push({ kind: index % 2 === 0 ? 'user' : 'assistant', text: `第 ${index} 句` })
    observations.push({ kind: 'tool', text: '运行命令的输出（不应进档案）' })
  }
  const { archive, covered, total } = buildArchive(observations, { maxItems: 10 })
  assert.ok(archive.split('\n').length <= 10)
  assert.doesNotMatch(archive, /运行命令的输出/)
  assert.equal(covered, 10)
  assert.equal(total, 100)
})

test('提案跨回放存活', async () => {
  const ctx = await fixture()
  try {
    ctx.engine.observe({
      type: 'user/message',
      data: {
        source: { kind: 'user' },
        content: [{ type: 'text', text: '我们聊了很多关于折叠两阶段与验收判据的事情，这一段值得留档' }],
      },
    })
    await ctx.engine.queue
    const proposal = await ctx.engine.proposeFold()
    const reopened = await openStore(ctx.dir, 's1')
    assert.equal(reopened.state.folds.get(proposal.id).status, 'pending')
    assert.equal(verifyProposal(reopened.state.folds.get(proposal.id), { loops: [] }).length, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('替换通过注入的 replacer 执行；拒绝或失败都如实记账，不假装替换过', async () => {
  const ctx = await fixture()
  try {
    ctx.engine.observe({
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这一整段值得留档，写长一点免得档案太短' }] },
    })
    await ctx.engine.queue

    const first = await ctx.engine.proposeFold()
    const ok = await ctx.engine.settleFold(first.id, {
      approve: true,
      replace: async () => ({ applied: true, seq: 42 }),
    })
    assert.equal(ok.applied, true)
    assert.equal(ok.replacement, 'applied')
    assert.equal(ok.proposal.appliedSeq, 42)

    const second = await ctx.engine.proposeFold()
    const refused = await ctx.engine.settleFold(second.id, {
      approve: true,
      replace: async () => ({ applied: false, reason: 'command:busy' }),
    })
    assert.equal(refused.applied, false)
    assert.equal(refused.replacement, 'command:busy')

    const third = await ctx.engine.proposeFold()
    const threw = await ctx.engine.settleFold(third.id, {
      approve: true,
      replace: async () => {
        throw new Error('boom')
      },
    })
    assert.equal(threw.applied, false)
    assert.match(threw.replacement, /threw:boom/)
  } finally {
    await ctx.cleanup()
  }
})
