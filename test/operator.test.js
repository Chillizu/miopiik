import test from 'node:test'
import assert from 'node:assert/strict'

import { assertAllowedOperatorModel, createOperator, resolveOperatorModel, shouldStall } from '../host/operator.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

const MIN = 60 * 1000
const base = { observedSeq: 10, lastSeen: 10, lastProgressAt: 1000, stallMs: 6 * MIN, now: 1000 + 7 * MIN }

test('卡住判定：还在跑、观测没变、超过静默阈值', () => {
  assert.equal(shouldStall({ ...base, job: { state: 'running' } }), true)
})

test('有产出就不算卡住（观测序号变了）', () => {
  assert.equal(shouldStall({ ...base, job: { state: 'running' }, observedSeq: 11 }), false)
})

test('没到阈值不报（避免把慢当成死）', () => {
  assert.equal(shouldStall({ ...base, job: { state: 'running' }, now: 1000 + 2 * MIN }), false)
})

test('任务已结束/超时/不存在都不报', () => {
  for (const state of ['done', 'failed', 'timeout', 'stalled']) {
    assert.equal(shouldStall({ ...base, job: { state } }), false, state)
  }
  assert.equal(shouldStall({ ...base, job: undefined }), false)
})

// ── 结构守卫：派发路径的核心部件曾被一次粗糙替换整块删掉，静默坏了很久 ──
const source = readFileSync(join(here, '..', 'host', 'operator.js'), 'utf8')

test('派发路径的守夜与子会话映射不能被误删', () => {
  assert.match(source, /childEngines\.set\(/, '必须登记子会话 → Ink 运行时的映射，否则 ink_report 找不到')
  assert.match(source, /const stallTimer = setInterval\(/, '无进展守夜必须有定时器')
  assert.match(source, /const timer = setTimeout\(/, '超时看门狗必须有定时器')
  assert.match(source, /attachJobToBranch\(/, '任务要挂到分支上')
})

test('收尾里用到的定时器名字必须在本文件内声明（catch 首行就抛过的坑）', () => {
  assert.match(source, /let stallTimer|const stallTimer =/, 'stallTimer 必须声明')
  assert.match(source, /const timer = setTimeout|let timer/, 'timer 必须声明')
})

test('任务板开卡失败不能阻断派发，且归属在中间层模块', () => {
  assert.match(source, /任务板开卡失败（不影响派发）/, '开卡要包在 try/catch 里')
  assert.match(source, /from '\.\/taskboard\.js'/, 'operator 应使用中间层的任务板模块')
})

test('「做了很多事却没有分支承载」要进 L3 可见性，而不是写成规则', () => {
  const engineSource = readFileSync(join(here, '..', 'host', 'engine.js'), 'utf8')
  assert.match(engineSource, /this\.lastWorkload = \{ turn, toolCount, coveredByBranch \}/, '要记录上一轮的工具强度')
  assert.match(engineSource, /没有分支承载它——如果这已经是一条要推进的线/, 'L3 要摆出这条事实')
  assert.match(engineSource, /如果只是查一下，忽略这行/, '给 M 留不做判断的自由')
})

test('resolveOperatorModel：支持 provider/model 简写、显式 provider+model、config 默认值与空回退', () => {
  assert.deepEqual(resolveOperatorModel({ model: 'opencode-go/glm-5.3' }), {
    provider: 'opencode-go',
    model: 'glm-5.3',
  })
  assert.deepEqual(resolveOperatorModel({ provider: 'opencode-go', model: 'glm-5.3' }), {
    provider: 'opencode-go',
    model: 'glm-5.3',
  })
  assert.deepEqual(resolveOperatorModel({ model: 'glm-5.3' }), {
    provider: 'opencode-go',
    model: 'glm-5.3',
  })
  assert.deepEqual(
    resolveOperatorModel({}, { operatorModel: { provider: 'opencode-go', model: 'glm-5.3' } }),
    { provider: 'opencode-go', model: 'glm-5.3' },
  )
  assert.equal(resolveOperatorModel({}), null)
})

function makeMockHarness({ stallMs = 60, timeoutMs = 5000, config = {}, services = {} } = {}) {
  const listeners = new Map()
  const activations = []
  let resolveActivation
  const resultPromise = new Promise((resolve) => {
    resolveActivation = resolve
  })

  const ctx = {
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => {}
    },
    emit(event, ...args) {
      for (const fn of listeners.get(event) ?? []) fn(...args)
    },
    get(name) {
      if (name === 'subagents') {
        return {
          list: () => ['subagent'],
          async startActivation(req) {
            activations.push(req)
            return {
              childId: 'child-session-1',
              result: resultPromise,
            }
          },
        }
      }
      return undefined
    },
  }

  const jobs = new Map()
  const delivered = []
  const engine = {
    state: {
      counters: { job: 0, obs: 0 },
      jobs,
    },
    async addLoop(loop) {
      return { id: 'L-1', ...loop }
    },
    async addJob(job) {
      this.state.counters.job += 1
      jobs.set(job.id, { ...job })
    },
    async updateJob(id, patch) {
      const cur = jobs.get(id)
      if (cur) jobs.set(id, { ...cur, ...patch })
    },
    async attachJobToBranch() {},
    async deliverNote(note, opts) {
      delivered.push({ note, opts })
    },
    async addDraft() {},
    async closeLoop() {},
  }

  const operator = createOperator({
    ctx,
    engines: new Map([['parent-session-1', engine]]),
    config: { operatorStallMs: stallMs, operatorTimeoutMs: timeoutMs, ...config },
    warn: () => {},
    services,
  })

  return { ctx, engine, operator, activations, jobs, delivered, resolveActivation }
}

test('createOperator：传入 model 时向 startActivation 注入 request.agentOptions 并记录 job.model', async () => {
  const { engine, operator, activations, jobs, resolveActivation } = makeMockHarness({
    stallMs: 60_000,
  })
  await operator.start({
    agent: { session: { id: 'parent-session-1' } },
    engine,
    input: {
      goal: '验证模型路由透传',
      draft: true,
      model: 'opencode-go/glm-5.3',
    },
  })
  assert.equal(activations.length, 1)
  assert.deepEqual(activations[0].request.agentOptions, {
    provider: 'opencode-go',
    model: 'glm-5.3',
  })
  assert.equal(jobs.get('J-1')?.model, 'opencode-go/glm-5.3')
  resolveActivation({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] })
})

test('createOperator 无进展守夜：父会话活跃不会掩盖卡住的子会话，子会话事件会推进观测计数', async () => {
  // 1) 父会话持续活跃，但子会话完全无事件 -> 应当判定 stalled
  const h1 = makeMockHarness({ stallMs: 60, timeoutMs: 2000 })
  await h1.operator.start({
    agent: { session: { id: 'parent-session-1' } },
    engine: h1.engine,
    input: { goal: '测试子会话卡死', draft: true },
  })
  // 模拟父会话不断聊天/推进 obs
  const parentTicker = setInterval(() => {
    h1.engine.state.counters.obs += 1
    h1.ctx.emit('session/event', { id: 'parent-session-1' }, { type: 'turn/end' })
  }, 15)

  await new Promise((r) => setTimeout(r, 140))
  clearInterval(parentTicker)
  assert.equal(h1.jobs.get('J-1')?.state, 'stalled', '父会话活跃不应阻止卡死的子会话被判定为 stalled')
  assert.equal(h1.delivered.length, 1)
  h1.resolveActivation({ stopReason: 'completed', output: [] })

  // 2) 子会话持续发出 session/event -> 不应被判定为 stalled
  const h2 = makeMockHarness({ stallMs: 80, timeoutMs: 2000 })
  await h2.operator.start({
    agent: { session: { id: 'parent-session-1' } },
    engine: h2.engine,
    input: { goal: '测试子会话正常推进', draft: true },
  })
  const childTicker = setInterval(() => {
    h2.ctx.emit('session/event', { id: 'child-session-1' }, { type: 'tool/result' })
  }, 20)

  await new Promise((r) => setTimeout(r, 140))
  clearInterval(childTicker)
  assert.equal(h2.jobs.get('J-1')?.state, 'running', '子会话有事件推进时应保持 running')
  assert.equal(h2.delivered.length, 0)
  h2.resolveActivation({ stopReason: 'completed', output: [] })
})

test('assertAllowedOperatorModel 与 createOperator：遵循 DSH subagentModelSelection 白名单', async () => {
  const servicesEnabled = {
    subagentModelSelection: {
      current: () => ({
        enabled: true,
        allowedModels: [{ provider: 'opencode-go', model: 'glm-5.3' }],
      }),
    },
  }

  // 1) 在白名单内 -> 放行
  const hAllowed = makeMockHarness({ stallMs: 60_000, services: servicesEnabled })
  await hAllowed.operator.start({
    agent: { session: { id: 'parent-session-1' } },
    engine: hAllowed.engine,
    input: { goal: '白名单模型允许派发', draft: true, model: 'opencode-go/glm-5.3' },
  })
  assert.equal(hAllowed.jobs.size, 1)
  hAllowed.resolveActivation({ stopReason: 'completed', output: [] })

  // 2) 不在白名单内 -> 抛错且不落脏 job
  const hBlocked = makeMockHarness({ stallMs: 60_000, services: servicesEnabled })
  await assert.rejects(
    () =>
      hBlocked.operator.start({
        agent: { session: { id: 'parent-session-1' } },
        engine: hBlocked.engine,
        input: { goal: '非白名单模型应拒绝', draft: true, model: 'opencode-go/not-in-whitelist' },
      }),
    /不在 DSH 子智能体模型白名单/,
  )
  assert.equal(hBlocked.jobs.size, 0, '被白名单拦截时不应该在账本中留下脏 job')

  // 3) enabled: false 时禁止显式指定异构模型，但允许与父会话同路由或省略 model
  const servicesDisabled = {
    subagentModelSelection: {
      current: () => ({
        enabled: false,
        allowedModels: [{ provider: 'opencode-go', model: 'glm-5.3' }],
      }),
    },
  }
  const hDisabled = makeMockHarness({ stallMs: 60_000, services: servicesDisabled })
  await assert.rejects(
    () =>
      hDisabled.operator.start({
        agent: { session: { id: 'parent-session-1' }, options: { provider: 'anthropic', model: 'claude' } },
        engine: hDisabled.engine,
        input: { goal: '未启用子模型选择时拒绝异构模型', draft: true, model: 'opencode-go/glm-5.3' },
      }),
    /模型选择未启用/,
  )
  assert.equal(hDisabled.jobs.size, 0)

  // 父会话本身就是 opencode-go/glm-5.3 时放行
  assert.doesNotThrow(() =>
    assertAllowedOperatorModel({
      agentOptions: { provider: 'opencode-go', model: 'glm-5.3' },
      agent: { options: { provider: 'opencode-go', model: 'glm-5.3' } },
      services: servicesDisabled,
    }),
  )
})
