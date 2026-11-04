import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openStore } from '../miopiik-dsh/host/store.js'
import { Engine } from '../miopiik-dsh/host/engine.js'
import { describeBranches } from '../miopiik-dsh/host/branches.js'

const T0 = Date.UTC(2026, 10, 1, 10, 0, 0)

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'miopiik-branch-'))
  const store = await openStore(dir, 's1')
  const engine = new Engine({ store, sessionId: 's1', now: () => T0 })
  return { dir, engine, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('分支从对话节点分叉：记下哪一轮、哪一句', async () => {
  const ctx = await fixture()
  try {
    const branch = await ctx.engine.openBranch({ label: '竞品扫描', summary: '看看别人首页怎么写的', forkedAtTurn: 7 })
    assert.equal(branch.id, 'B-1')
    assert.equal(branch.forkedAtTurn, 7)
    assert.equal(branch.status, 'open')
    assert.ok(Number.isInteger(branch.forkedAtSeq))
  } finally {
    await ctx.cleanup()
  }
})

test('分支是鱼骨的肋骨：L3 列出「有哪些分支」，带任务计数', async () => {
  const ctx = await fixture()
  try {
    const branch = await ctx.engine.openBranch({ label: '定位验证', summary: '确认假设是否成立' })
    await ctx.engine.addJob({ id: 'J-1', label: '扫竞品', branchId: branch.id, state: 'done' })
    await ctx.engine.addJob({ id: 'J-2', label: '看差异', branchId: branch.id, state: 'running' })

    const l3 = ctx.engine.l3Text()
    assert.match(l3, /鱼骨分支：/)
    assert.match(l3, /B-1 定位验证：确认假设是否成立（2 个任务（1 完成 \/ 1 在跑）/)
  } finally {
    await ctx.cleanup()
  }
})

test('汇回主干：merge 产出带指针的预览（进收件箱），分支转 merged', async () => {
  const ctx = await fixture()
  try {
    const branch = await ctx.engine.openBranch({ label: '竞品扫描', summary: '看看别人怎么写' })
    await ctx.engine.addJob({ id: 'J-1', label: '扫竞品', branchId: branch.id, state: 'done' })
    const { branch: merged, note } = await ctx.engine.mergeBranch(branch.id, { claim: '竞品都在打防御定价' })

    assert.equal(merged.status, 'merged')
    assert.equal(merged.mergedInto, note.id)
    assert.deepEqual(note.refs, [branch.id, 'J-1'])
    assert.match(note.question, /接回刚才那条线/)
    assert.equal(ctx.engine.inboxView().previews.length, 1)
    assert.equal(ctx.engine.listBranches().length, 0, '合并后不再占「open」')
  } finally {
    await ctx.cleanup()
  }
})

test('分支可放弃；一句话摘要可更新，历史仍在', async () => {
  const ctx = await fixture()
  try {
    const branch = await ctx.engine.openBranch({ label: '旧想法' })
    await ctx.engine.updateBranchSummary(branch.id, '换了个说法')
    assert.equal(ctx.engine.listBranches()[0].summary, '换了个说法')
    const abandoned = await ctx.engine.abandonBranch(branch.id, { reason: '不做了' })
    assert.equal(abandoned.status, 'abandoned')
    assert.equal(ctx.engine.listBranches().length, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('describeBranches：最多 4 条，没有任务时如实说"还没有任务"', () => {
  const branches = [
    { id: 'B-1', label: 'a', summary: '', status: 'open', forkedAtTurn: 1, jobs: [] },
    { id: 'B-2', label: 'b', summary: 'x', status: 'open', forkedAtTurn: null, jobs: [] },
  ]
  const lines = describeBranches(branches, [])
  assert.equal(lines.length, 2)
  assert.match(lines[0], /还没有任务/)
  assert.doesNotMatch(lines[1], /从第/)
})

test('数据卫生：历史上被误记为 user 的系统注入消息，回放时改判为 system（不改磁盘）', async () => {
  const { appendFile, mkdtemp, rm: rmDir } = await import('node:fs/promises')
  const { tmpdir: tmp } = await import('node:os')
  const { join: joinPath } = await import('node:path')
  const dir = await mkdtemp(joinPath(tmp(), 'miopiik-hygiene-'))
  try {
    const legacy = [
      { seq: 1, at: T0, day: 1, turn: 1, kind: 'user', text: '<goal_round>Round: 1</goal_round>' },
      { seq: 2, at: T0, day: 1, turn: 1, kind: 'user', text: 'Time sampled while preparing turn 1' },
      { seq: 3, at: T0, day: 1, turn: 1, kind: 'user', text: '我想做个东西' },
    ]
    await appendFile(joinPath(dir, 'observations.jsonl'), legacy.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    const store = await openStore(dir, 's1')
    const kinds = store.state.observations.map((entry) => entry.kind)
    assert.deepEqual(kinds, ['system', 'system', 'user'])

    const engine = new Engine({ store, sessionId: 's1', now: () => T0 })
    const rhythm = engine.conversationRhythm()
    assert.ok(rhythm === null || !/612 字/.test(rhythm), '系统注入不参与对话节奏')
  } finally {
    await rmDir(dir, { recursive: true, force: true })
  }
})
