import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openStore } from '../host/store.js'
import { Engine } from '../host/engine.js'
import { createOperator } from '../host/operator.js'
import { registerTools } from '../host/tools.js'

/**
 * ink_dispatch.facts 工具级验收（SPEC §13.9）：
 * 合法落账（job.facts 随任务记录进账本、跨回放存活）、未知 id 报错
 * （与 updateBranchContext 同口径，且先于开分支等一切落账动作）、
 * 不传时任务记录形状与现状逐字节一致。
 */

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'miopiik-dispatch-'))
  const store = await openStore(dir, 'session-1')
  const engine = new Engine({ store, sessionId: 'session-1' })
  return {
    dir,
    engine,
    async cleanup() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** 装一套真的工具面：真 Engine + mock subagents 通道 + 真 createOperator。 */
async function loadTools(ctx) {
  const activations = []
  let resolveActivation
  const resultPromise = new Promise((resolve) => {
    resolveActivation = resolve
  })
  const operatorCtx = {
    on() {
      return () => {}
    },
    get(name) {
      if (name !== 'subagents') return undefined
      return {
        list: () => ['subagent'],
        async startActivation(request) {
          activations.push(request)
          return { childId: 'child-1', result: resultPromise }
        },
      }
    },
  }
  const operator = createOperator({
    ctx: operatorCtx,
    engines: new Map(),
    config: { operatorStallMs: 60_000, operatorTimeoutMs: 60_000 },
    warn: () => {},
  })
  const registered = []
  registerTools(
    { tools: { register: (definition) => registered.push(definition) } },
    new Map([['session-1', ctx.engine]]),
    operator,
  )
  const dispatch = registered.find((definition) => definition.name === 'ink_dispatch')
  assert.ok(dispatch !== undefined, 'ink_dispatch 应已注册')
  const exec = { agent: { session: { id: 'session-1' } } }
  return { dispatch, exec, activations, resolveActivation }
}

const flush = async () => {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

const CONTRACT = {
  goal: '验证 facts 落账',
  deliverables: 'job 记录带 facts 字段',
  acceptance: 'job.facts 与派发参数一致',
  acceptanceSample: 'J-1 的 facts 为 ["F-1"]',
  boundary: '只改 host/tools.js',
  budget: '10 分钟',
}

test('ink_dispatch.facts：合法 id 随 job 记录落账并跨回放存活，分支照常自动开', async () => {
  const ctx = await fixture()
  try {
    await ctx.engine.addFact({ claim: '契约依赖的事实', provenance: ['test'], conf: 'high' })
    const { dispatch, exec, activations, resolveActivation } = await loadTools(ctx)
    const out = await dispatch.execute({ ...CONTRACT, branch: '线A', facts: ['F-1'] }, exec)
    assert.equal(out.branch, 'B-1', '派发时带分支名要自动开分支')
    assert.equal(activations.length, 1, 'Operator 激活一次')
    const job = ctx.engine.state.jobs.get(out.jobId)
    assert.deepEqual(job.facts, ['F-1'], 'job.facts 就是派发声明')
    assert.equal(job.branchId, 'B-1')
    // JSONL 原文带 facts：append-only 记录只增字段。
    const line = readFileSync(join(ctx.dir, 'jobs.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .find((entry) => entry.includes(`"id":"${out.jobId}"`))
    assert.ok(line !== undefined)
    assert.match(line, /"facts":\["F-1"\]/u)
    // 重开目录（回放即真相）后仍在。
    const reopened = await openStore(ctx.dir, 'session-1')
    assert.deepEqual(reopened.state.jobs.get(out.jobId).facts, ['F-1'])
    resolveActivation({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] })
    await flush()
  } finally {
    await ctx.cleanup()
  }
})

test('ink_dispatch.facts：未知 id 报错（与 updateBranchContext 同口径），不落任何脏记录', async () => {
  const ctx = await fixture()
  try {
    await ctx.engine.addFact({ claim: '在账的事实', provenance: ['test'], conf: 'mid' })
    const { dispatch, exec } = await loadTools(ctx)
    // 草稿态也要先过事实校验：缺这一步会开分支、落任务，再在别处炸。
    await assert.rejects(
      () => dispatch.execute({ goal: '未知事实', draft: true, branch: '不该出现', facts: ['F-1', 'F-404'] }, exec),
      /引用了不存在的事实卡：F-404/u,
    )
    assert.equal(ctx.engine.state.counters.job, 0, '不该落任务')
    assert.equal([...ctx.engine.state.branches.values()].length, 0, '校验先于开分支，不留下半开的分支')
    assert.deepEqual(ctx.engine.backstageSnapshot().graph.links, [], '没落账就没有线间关系')
  } finally {
    await ctx.cleanup()
  }
})

test('ink_dispatch 不传 facts：任务记录形状与现状逐字节一致（无 facts 字段）', async () => {
  const ctx = await fixture()
  try {
    const { dispatch, exec, resolveActivation } = await loadTools(ctx)
    const out = await dispatch.execute({ ...CONTRACT }, exec)
    const job = ctx.engine.state.jobs.get(out.jobId)
    assert.equal('facts' in job, false, '不传就不写 facts 字段')
    // 钉住记录形状：除新增可选字段外一个键都不多。
    assert.deepEqual(Object.keys(job), [
      'id',
      'label',
      'contract',
      'model',
      'loopId',
      'branchId',
      'childId',
      'state',
      'startedAt',
      'endedAt',
      'stopReason',
      'createdAt',
    ])
    const line = readFileSync(join(ctx.dir, 'jobs.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .find((entry) => entry.includes(`"id":"${out.jobId}"`))
    assert.doesNotMatch(line, /"facts"/u, 'JSONL 原文不带 facts 键')
    resolveActivation({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] })
    await flush()
  } finally {
    await ctx.cleanup()
  }
})
