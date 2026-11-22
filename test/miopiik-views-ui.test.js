import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script, createContext } from 'node:vm'

import { openStore } from '../host/store.js'
import { Engine } from '../host/engine.js'
import { registerBackstageCommand } from '../host/commands.js'

const root = new URL('../', import.meta.url)
const clientPath = new URL('client.js', root)
const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 10, 1, 10, 0, 0)

// ── 真引擎夹具：三视图消费的投影键与命令通道都是真的，不造数据 ──────────

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'miopiik-views-'))
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

/** 铺一层覆盖三视图所需的账本：L-1 / F-1 / I-1 / J-1 / B-1、B-2（共享 F-1）。 */
async function seedLedger(ctx, { fillerFacts = 0, extraTurns = 0 } = {}) {
  const { engine } = ctx
  const step = (ms = 7000) => ctx.advance(ms)
  await engine.observe({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把三视图接上真实数据面' }] } })
  step()
  await engine.addLoop({ text: '三视图的数据契约还没验', type: 'forming-intent', closureCondition: '游标翻页走通' })
  step()
  await engine.addFact({ claim: '账本是 append-only JSONL（回放即真相）', provenance: ['SPEC §2.2'], conf: 'high' })
  step()
  const branch = await engine.openBranch({
    label: '取数通道',
    summary: 'audit 命令装 JSON 带回浏览器',
    premise: '命令通道已被干预按钮证明可达',
    quotes: ['流水也能真的让我详细看到所有详细操作'],
    facts: ['F-1'],
  })
  step()
  await engine.deliverNote({ kind: 'absorb', claim: '这轮在看账本本身', why: 'no-signal', conf: 'low', refs: [] })
  step()
  await engine.addJob({
    id: 'J-1',
    label: '重建三视图',
    branchId: branch.id,
    state: 'running',
    startedAt: engine.now(),
    loopId: 'L-1',
    contract: { goal: '三视图消费真实投影', deliverables: '三个 pane', acceptance: 'node --test 全绿', boundary: '只改 client.js', budget: '60 分钟' },
  })
  step()
  await engine.updateJob('J-1', { state: 'failed', endedAt: engine.now(), stopReason: 'start-failed' })
  step()
  await engine.deliverNote({
    kind: 'preview',
    claim: '「三视图的数据契约还没验」有了新进展',
    why: 'compile:conversation',
    question: '现在就接上吗？',
    refs: ['L-1'],
    loops: ['L-1'],
  })
  step()
  await engine.openBranch({ label: '线间关系', summary: '与取数通道共享 F-1', facts: ['F-1'] })
  step()
  await engine.mergeBranch('B-1', { claim: '取数通道有结论了' })
  step()
  await engine.abandonBranch('B-2', { reason: '验证完毕' })
  step()
  await engine.advanceEpoch({ note: '换到装配验证' })
  // 填充结论：把账本撑过单页 50 行，「更早」才有第二页可翻。
  for (let index = 0; index < fillerFacts; index += 1) {
    step()
    await engine.addFact({ claim: `填充结论 ${index}：用于翻页`, provenance: ['test'], conf: 'low' })
  }
  // 额外轮次：把主干撑过 16 轮，截断标记才说真话。
  for (let turn = 2; turn <= extraTurns + 1; turn += 1) {
    engine.observe({ type: 'turn/start', data: { turn } })
    engine.observe({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `第 ${turn} 轮的话` }] } })
  }
  await engine.queue
}

/** 假 remote：把 /miopiik 命令行交给真注册的 host 命令（与浏览器端同一入口）。 */
function makeRemote(engine, { fail = false } = {}) {
  const registered = []
  registerBackstageCommand(
    { get: (name) => (name === 'commands' ? { register: (definition) => registered.push(definition) } : undefined), effect: (fn) => fn() },
    new Map([['session-1', engine]]),
  )
  assert.equal(registered.length, 1)
  const command = registered[0]
  const lines = []
  return {
    lines,
    commands: {
      async execute(sessionId, line, attachments) {
        lines.push(String(line))
        if (fail) throw new Error('command channel is down')
        // attachments 是 VM realm 的数组：assert/strict 的 deepEqual 比原型会炸，用逐字段断言。
        assert.ok(Array.isArray(attachments) && attachments.length === 0)
        const outcome = await command.handler({ agent: { session: { id: sessionId } }, rawInput: String(line).slice('/miopiik'.length) })
        if (outcome.kind === 'success') return { ok: true, value: { commandId: 'cmd-test', result: { kind: 'success', text: outcome.text } } }
        return { ok: false, error: { code: 'command-error', message: outcome.text } }
      },
    },
  }
}

// ── React 桩：hook 单元按「组件名 + 树路径」跨渲染复用（多组件同走一趟也稳）──

function makeReactStub() {
  const cells = new Map()
  let frame = { prefix: 'root', cursor: 0 }
  const slotKey = () => `${frame.prefix}#${frame.cursor++}`
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      const key = slotKey()
      if (!cells.has(key)) cells.set(key, { value: typeof initial === 'function' ? initial() : initial })
      const cell = cells.get(key)
      return [
        cell.value,
        (next) => {
          cell.value = typeof next === 'function' ? next(cell.value) : next
        },
      ]
    },
    useRef(initial) {
      const key = slotKey()
      if (!cells.has(key)) cells.set(key, { value: { current: initial } })
      return cells.get(key).value
    },
    useEffect(fn) {
      fn()
      return () => {}
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      slotKey()
      subscribe?.(() => {})
      return getSnapshot?.()
    },
  }
  function renderNode(node, path) {
    if (node === null || node === undefined) return []
    if (Array.isArray(node)) return node.flatMap((child, index) => renderNode(child, `${path}/${index}`))
    if (typeof node.type === 'function') {
      const prev = frame
      frame = { prefix: `${node.type.name}@${path}`, cursor: 0 }
      try {
        return renderNode(node.type({ ...node.props, children: node.children }), `${path}()`)
      } finally {
        frame = prev
      }
    }
    return [node, ...(node.children ?? []).flatMap((child, index) => renderNode(child, `${path}.${index}`))]
  }
  // conversation.view 的 slot render 就是组件本体：render(props) 时根 frame 已在跑 hooks，
  // 所以每次 walk 前必须重置根 frame，hook 单元才能跨渲染按位复用。
  const render = (element) => {
    frame = { prefix: 'root', cursor: 0 }
    return renderNode(element, 'r')
  }
  return { React, render }
}

function slotByName(slots, name) {
  const entry = slots.find((slot) => slot.meta.name === name)
  assert.ok(entry !== undefined, 'missing slot: ' + name)
  return entry
}

/** 装载 client.js 并把会话视图跑起来；remote 形参接管命令通道。 */
function loadViews({ snapshot, remote } = {}) {
  const source = readFileSync(clientPath, 'utf8')
  let module
  const sandbox = { console }
  sandbox.window = sandbox
  sandbox.__ModuleLoader__ = { load(value) { module = value } }
  createContext(sandbox)
  new Script(source, { filename: 'client.js' }).runInContext(sandbox, { timeout: 5000 })
  assert.equal(module.id, 'miopiik-dsh')

  const stub = makeReactStub()
  const plugin = module.factory((name) => {
    if (name === 'react') return stub.React
    throw new Error('unexpected dependency: ' + name)
  })

  const slots = []
  plugin.apply({
    effect(fn) {
      fn()
    },
    inject() {},
    locale: { register() {}, bind() { return (key) => key } },
    remote,
    slots: {
      inject(name, callback) {
        if (name === 'conversation.view' || name === 'plugins.bundle.config') callback()
      },
      register(meta, renderFn) {
        slots.push({ meta, render: renderFn })
        return () => {}
      },
    },
  })

  const walk = () =>
    stub.render(slotByName(slots, 'conversation.view').render({ sessionId: 'session-1', useProjection: () => snapshot }))
  return { plugin, slots, stub, walk, source }
}

// ── 节点查找小工具 ────────────────────────────────────────────────────

const textOf = (nodes) =>
  nodes.flatMap((node) => (node.children ?? []).filter((child) => typeof child === 'string')).join(' ')
const byKey = (nodes, key) => nodes.find((node) => node.props?.key === key)
const byAttr = (nodes, attr, value) => nodes.find((node) => node.props?.[attr] === value)
const buttonByText = (nodes, label) =>
  nodes.find((node) => node.type === 'button' && String(node.children?.[0] ?? '').startsWith(label))
const rowNodes = (nodes) => nodes.filter((node) => node.props?.['data-miopiik-row'] !== undefined)
/** 行节点 → { key, kind, claim }（time/kind/claim 是行内前三个 span 的字符串孩子）。 */
const displayedRows = (nodes) =>
  rowNodes(nodes).map((node) => ({
    key: String(node.props['data-miopiik-row']),
    kind: String(node.children[1]?.children?.[0] ?? ''),
    claim: String(node.children[2]?.children?.[0] ?? ''),
  }))
/** 与客户端同一套行键公式，从引擎全集算出「屏幕上应有」的行序列。 */
const expectedRows = (rows) => {
  const seen = new Map()
  return rows.map((row) => {
    const base = `${row.id}|${row.kind}|${row.at}`
    const nth = (seen.get(base) ?? 0) + 1
    seen.set(base, nth)
    return { key: nth === 1 ? base : `${base}#${nth}`, kind: row.kind, claim: row.claim }
  })
}
const plain = (value) => JSON.parse(JSON.stringify(value))
const flush = async () => {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}
const toTab = (load, label) => {
  const nodes = load.walk()
  const button = buttonByText(nodes, label)
  assert.ok(button !== undefined, `应有页签按钮 ${label}`)
  button.props.onClick()
  return load.walk()
}
/** 溯源跳转后落地：先走一趟让挂载效应发出请求，flush 等回包，再走两趟让状态落屏。 */
const settleTrace = async (load) => {
  load.walk()
  await flush()
  load.walk()
  return load.walk()
}

// ── 所见（ContextPane）───────────────────────────────────────────────

test('所见：L3 原文与注入 Mind 的同文，等宽原样渲染', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    const snapshot = ctx.engine.backstageSnapshot()
    const load = loadViews({ snapshot })
    const nodes = toTab(load, 'tab.context')
    const block = byAttr(nodes, 'data-miopiik-l3-text', '1')
    assert.ok(block !== undefined, '应有 data-miopiik-l3-text 等宽块')
    assert.equal(block.children[0], snapshot.l3.text, '原文必须逐字渲染，不截断不改写')
    assert.equal(snapshot.l3.text, ctx.engine.l3Text(), '快照里的 text 就是注入 Mind 的那段')
    assert.match(String(block.props.style.fontFamily), /monospace/u)
    assert.equal(block.props.style.whiteSpace, 'pre-wrap')
  } finally {
    await ctx.cleanup()
  }
})

test('所见：sections 分节现值渲染，F-x / L-n / I-x 可点溯源', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    const snapshot = ctx.engine.backstageSnapshot()
    const load = loadViews({ snapshot, remote: makeRemote(ctx.engine) })
    const nodes = toTab(load, 'tab.context')
    // 三个 section 都在，行内容来自 sections 现值。
    assert.ok(byAttr(nodes, 'data-miopiik-trace', 'F-1') !== undefined)
    assert.ok(byAttr(nodes, 'data-miopiik-trace', 'L-1') !== undefined)
    assert.ok(byAttr(nodes, 'data-miopiik-trace', 'I-1') !== undefined)
    assert.match(textOf(nodes), /账本是 append-only JSONL（回放即真相）/u)
    assert.match(textOf(nodes), /graph\.closure: 游标翻页走通/u)
    assert.match(textOf(nodes), /三视图的数据契约还没验/u)
    // I-1 溯源 → 流水里直达那条投递的详情（自动展开）。
    byAttr(nodes, 'data-miopiik-trace', 'I-1').props.onClick()
    const traced = await settleTrace(load)
    assert.match(textOf(traced), /「三视图的数据契约还没验」有了新进展/u)
    assert.match(textOf(traced), /stream\.detailClaim/u, '收件箱溯源应自动展开详情')
    assert.match(textOf(traced), /现在就接上吗？/u)
  } finally {
    await ctx.cleanup()
  }
})

test('所见：Ink 装配明细默认折叠，展开才见 head/tail/候选', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    const snapshot = ctx.engine.backstageSnapshot()
    assert.ok(snapshot.inkContext.head.length > 0, '夹具要先折一段头部（advanceEpoch）')
    const load = loadViews({ snapshot })
    let nodes = toTab(load, 'tab.context')
    assert.doesNotMatch(textOf(nodes), /- \[note\] absorb/u, '折叠态不该把装配明细倒出来')
    const expand = buttonByText(nodes, 'ctx.assemblyExpand')
    assert.ok(expand !== undefined)
    expand.props.onClick()
    nodes = load.walk()
    assert.match(textOf(nodes), /- \[note\] absorb｜这轮在看账本本身/u, '展开后 head 原文可见')
    assert.match(textOf(nodes), /ctx\.candidates/u)
  } finally {
    await ctx.cleanup()
  }
})

test('所见：空 L3 显示空态，不造内容', async () => {
  const ctx = await fixture()
  try {
    const snapshot = ctx.engine.backstageSnapshot()
    assert.equal(snapshot.l3.text, '')
    const load = loadViews({ snapshot })
    const nodes = toTab(load, 'tab.context')
    assert.match(textOf(nodes), /ctx\.empty/u)
    assert.equal(byAttr(nodes, 'data-miopiik-l3-text', '1'), undefined)
  } finally {
    await ctx.cleanup()
  }
})

// ── 流水（StreamPane）────────────────────────────────────────────────

test('流水：首屏是投影尾窗，不是命令通道', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    const snapshot = ctx.engine.backstageSnapshot()
    const remote = makeRemote(ctx.engine)
    const load = loadViews({ snapshot, remote })
    const nodes = toTab(load, 'tab.stream')
    // 尾窗采样：3 note + 1 事实现值 + 2 分支状态 + 1 job。
    assert.equal(rowNodes(nodes).length, 7)
    assert.match(textOf(nodes), /stream\.tailHint/u)
    assert.match(textOf(nodes), /fact\.sample/u)
    assert.match(textOf(nodes), /job\.sample/u)
    assert.equal(remote.lines.length, 0, '首屏不该动命令通道')
    assert.equal(buttonByText(nodes, 'stream.earlier') !== undefined, true)
    assert.equal(buttonByText(nodes, 'fact.add') === undefined, true, '命令没跑过就不该有 kind 按钮')
  } finally {
    await ctx.cleanup()
  }
})

test('流水：「更早」走命令通道，游标续翻到最早，拼接 = 全集', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx, { fillerFacts: 45 })
    const full = ctx.engine.auditPage({ limit: 200 }).rows
    assert.ok(full.length > 50 && full.length < 200, `夹具要 50–200 行（实际 ${full.length}）`)
    const snapshot = ctx.engine.backstageSnapshot()
    const remote = makeRemote(ctx.engine)
    const load = loadViews({ snapshot, remote })
    let nodes = toTab(load, 'tab.stream')
    // 尾窗采样：3 note + 12 事实现值（快照 slice(-12)）+ 2 分支状态 + 1 job。
    assert.equal(rowNodes(nodes).length, 18, '首屏仍是尾窗')
    // 第一页：无过滤，limit 固定 50；连点两次也只发一条（合并进在飞那页）。
    const earlier = buttonByText(nodes, 'stream.earlier')
    earlier.props.onClick()
    earlier.props.onClick()
    assert.equal(remote.lines.length, 1, '在飞期间重复点击要被合并')
    assert.equal(remote.lines[0], '/miopiik audit limit=50')
    await flush()
    nodes = load.walk()
    assert.equal(rowNodes(nodes).length, 50)
    assert.match(textOf(nodes), /stream\.loaded 50/u)
    // 第二页：游标来自上一页的 nextCursor，行只追加不刷屏。
    const page1 = ctx.engine.auditPage({ limit: 50 })
    assert.ok(page1.nextCursor !== null && page1.nextCursor.before !== undefined)
    buttonByText(nodes, 'stream.earlier').props.onClick()
    await flush()
    nodes = load.walk()
    assert.match(textOf(nodes), /stream\.exhausted/u, '翻完给截断句，按钮撤下')
    assert.equal(buttonByText(nodes, 'stream.earlier'), undefined)
    assert.equal(remote.lines[1], `/miopiik audit before=${page1.nextCursor.before} beforeSeq=${page1.nextCursor.beforeSeq} limit=50`)
    // 拼接结果与一次取全 deep-equal：从最新到最早无缺口、不重不漏。
    assert.deepEqual(plain(displayedRows(nodes)), plain(expectedRows(full)))
  } finally {
    await ctx.cleanup()
  }
})

test('流水：kind 过滤器按命令返回的行生成，过滤走服务端 kind=', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx, { fillerFacts: 45 })
    const snapshot = ctx.engine.backstageSnapshot()
    const remote = makeRemote(ctx.engine)
    const load = loadViews({ snapshot, remote })
    let nodes = toTab(load, 'tab.stream')
    buttonByText(nodes, 'stream.earlier').props.onClick()
    await flush()
    nodes = load.walk()
    // kind 按钮按返回行生成：本账本里有 fact.add 就有这个按钮。
    const factButton = buttonByText(nodes, 'fact.add')
    assert.ok(factButton !== undefined, '返回行里有 fact.add，就该有这个 kind 按钮')
    factButton.props.onClick()
    await flush()
    nodes = load.walk()
    assert.match(remote.lines.at(-1), /^\/miopiik audit .*limit=50.*kind=fact\.add$/u)
    const rows = displayedRows(nodes)
    assert.ok(rows.length >= 45)
    assert.ok(rows.every((row) => row.kind === 'fact.add'), '过滤后的行全是 fact.add')
  } finally {
    await ctx.cleanup()
  }
})

test('流水：命令通道不可用时降级，如实停在尾窗', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    const snapshot = ctx.engine.backstageSnapshot()
    const remote = makeRemote(ctx.engine, { fail: true })
    const load = loadViews({ snapshot, remote })
    let nodes = toTab(load, 'tab.stream')
    buttonByText(nodes, 'stream.earlier').props.onClick()
    await flush()
    nodes = load.walk()
    assert.equal(rowNodes(nodes).length, 7, '尾窗行原样保留')
    assert.match(textOf(nodes), /command channel is down/u)
    assert.match(textOf(nodes), /stream\.tailOnly/u, '要说清只能看到尾窗')
    assert.match(textOf(nodes), /stream\.tailHint/u)
    assert.equal(buttonByText(nodes, 'stream.earlier') !== undefined, true, '通道恢复后还能重试')
  } finally {
    await ctx.cleanup()
  }
})

test('流水：溯源（L-1）自动接通道并翻到对象所在页', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx, { fillerFacts: 45 })
    const snapshot = ctx.engine.backstageSnapshot()
    const remote = makeRemote(ctx.engine)
    const load = loadViews({ snapshot, remote })
    // 从所见页点 L-1：对象在第 2 页里，自动翻页直到它出现。
    const nodes = toTab(load, 'tab.context')
    byAttr(nodes, 'data-miopiik-trace', 'L-1').props.onClick()
    const traced = await settleTrace(load)
    const rows = displayedRows(traced)
    assert.ok(rows.length >= 2, 'L-1 的操作行 + 引用它的 note 行都要在')
    assert.ok(rows.some((row) => row.kind === 'loop.add' && row.claim === '三视图的数据契约还没验'))
    assert.ok(rows.some((row) => row.claim === '「三视图的数据契约还没验」有了新进展'), 'refs 引用它的行也算溯源')
    assert.equal(remote.lines.length, 2, '对象不在第一页时自动续翻一页')
    assert.match(remote.lines[1], /^\/miopiik audit before=/u)
    assert.match(textOf(traced), /L-1 ×/u, '溯源过滤要有可见的撤销入口')
  } finally {
    await ctx.cleanup()
  }
})

// ── 鱼骨（FishboneView 泳道化）───────────────────────────────────────

test('鱼骨：泳道化布局——左脊、每分支一条泳道、事件落自己泳道', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    const snapshot = ctx.engine.backstageSnapshot()
    const load = loadViews({ snapshot })
    const nodes = load.walk()
    assert.ok(nodes.some((node) => node.type === 'svg'), '画布在场')
    assert.ok(byKey(nodes, 'spine-l') !== undefined, '左脊（对话轮次）保留')
    assert.match(textOf(nodes), /graph\.allTurns 1/u, '未截断时说全部轮次')
    // 两条泳道：基线 + 标题各就各位。
    assert.ok(byKey(nodes, 'lanebase-B-1') !== undefined)
    assert.ok(byKey(nodes, 'lanebase-B-2') !== undefined)
    assert.match(textOf(nodes), /B-1 取数通道/u)
    assert.match(textOf(nodes), /B-2 线间关系/u)
    const fork1 = byKey(nodes, 'e-fork:B-1')
    const fork2 = byKey(nodes, 'e-fork:B-2')
    assert.ok(fork1 !== undefined && fork2 !== undefined)
    assert.ok(fork1.props.cx < fork2.props.cx, '两条分支各占一条泳道')
    // fork/merge/abandon/job 都落在自己泳道：B-1 的 job 方点与 B-1 的 fork 同 x。
    const job = byAttr(nodes, 'data-miopiik-job-node', 'J-1')
    assert.ok(job !== undefined)
    assert.equal(job.props.x + job.props.width / 2, fork1.props.cx, 'job 方点落在 B-1 泳道')
    assert.ok(byKey(nodes, 'e-merge:B-1') !== undefined, '汇回事件在泳道上')
    assert.ok(byKey(nodes, 'e-merge:B-2') !== undefined, '放弃事件在泳道上（host 用 merge: 前缀记 settle）')
    // 主色只给脊：泳道基线与脊的用色不同档。
    assert.notEqual(byKey(nodes, 'lanebase-B-1').props.strokeWidth, byKey(nodes, 'spine-l').props.strokeWidth)
  } finally {
    await ctx.cleanup()
  }
})

test('鱼骨：主干超过 16 轮时显示截断标记', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx, { extraTurns: 20 })
    const snapshot = ctx.engine.backstageSnapshot()
    assert.equal(snapshot.graph.turnsTruncated, true)
    assert.equal(snapshot.graph.turns.length, 16)
    const load = loadViews({ snapshot })
    const nodes = load.walk()
    assert.match(textOf(nodes), /graph\.recentTurns 16\/21/u)
  } finally {
    await ctx.cleanup()
  }
})

test('鱼骨：共享事实画跨泳道细线，悬停出事实号，点击去流水溯源', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    const snapshot = ctx.engine.backstageSnapshot()
    assert.deepEqual(snapshot.graph.links, [{ kind: 'shared-fact', factId: 'F-1', between: ['B-1', 'B-2'] }])
    const remote = makeRemote(ctx.engine)
    const load = loadViews({ snapshot, remote })
    let nodes = load.walk()
    const link = byAttr(nodes, 'data-miopiik-shared-fact', 'F-1')
    assert.ok(link !== undefined, 'B-1 与 B-2 之间应有共享 F-1 的细线')
    const fork1 = byKey(nodes, 'e-fork:B-1')
    const fork2 = byKey(nodes, 'e-fork:B-2')
    assert.equal(link.props.x1, fork1.props.cx, '连线从 B-1 泳道出发')
    assert.equal(link.props.x2, fork2.props.cx, '连到 B-2 泳道')
    // 悬停：气泡给事实号。
    link.props.onMouseEnter()
    nodes = load.walk()
    assert.match(textOf(nodes), /graph\.sharedFact F-1/u)
    // 点击：跳流水溯源该事实。
    link.props.onClick()
    nodes = await settleTrace(load)
    const rows = displayedRows(nodes)
    assert.ok(rows.length >= 1)
    assert.ok(rows.some((row) => row.kind === 'fact.add' && row.claim === '账本是 append-only JSONL（回放即真相）'))
  } finally {
    await ctx.cleanup()
  }
})

test('鱼骨：详情侧栏补 job 的 stopReason 与契约目标，J-n 可跳流水', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    const snapshot = ctx.engine.backstageSnapshot()
    const remote = makeRemote(ctx.engine)
    const load = loadViews({ snapshot, remote })
    let nodes = load.walk()
    byKey(nodes, 'e-fork:B-1').props.onClick()
    nodes = load.walk()
    assert.equal(byAttr(nodes, 'data-miopiik-branch-detail', 'B-1') !== undefined, true)
    const detail = textOf(nodes)
    assert.match(detail, /命令通道已被干预按钮证明可达/u, 'premise 在')
    assert.match(detail, /流水也能真的让我详细看到所有详细操作/u, 'quotes 在')
    assert.match(detail, /graph\.stopReason: start-failed/u, 'job 带 stopReason')
    assert.match(detail, /graph\.contract: 三视图消费真实投影/u, '契约目标来自派发时的 contract')
    // jobs 方点（Operator）悬停带 stopReason 提示。
    byAttr(nodes, 'data-miopiik-job-node', 'J-1').props.onMouseEnter()
    nodes = load.walk()
    assert.match(textOf(nodes), /graph\.stopReason: start-failed/u, '方点悬停要给 stopReason')
    // J-1 跳流水：任务的操作行（dispatch/update）都能溯源到。
    byAttr(nodes, 'data-miopiik-job', 'J-1').props.onClick()
    nodes = await settleTrace(load)
    const rows = displayedRows(nodes)
    assert.ok(rows.some((row) => row.kind === 'job.dispatch'))
    assert.ok(rows.some((row) => row.kind === 'job.update'))
    assert.ok(rows.some((row) => row.claim === '重建三视图'))
    // 既有入口保留：openStream 按分支过滤走服务端 branch=。
    const back = toTab(load, 'tab.graph')
    byKey(back, 'e-fork:B-2').props.onClick()
    nodes = load.walk()
    buttonByText(nodes, 'graph.openStream').props.onClick()
    nodes = await settleTrace(load)
    assert.match(textOf(nodes), /B-2 ×/u, '分支过滤片在场')
    assert.match(remote.lines.at(-1), /^\/miopiik audit .*limit=50.*branch=B-2$/u)
    assert.ok(displayedRows(nodes).length >= 1)
  } finally {
    await ctx.cleanup()
  }
})

// ── 互通与既有面零破坏 ───────────────────────────────────────────────

test('鱼骨：头部图例一行在场——接出/接回/共享事实/方/圆，贴着最近轮次标记', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    const snapshot = ctx.engine.backstageSnapshot()
    const load = loadViews({ snapshot })
    const nodes = load.walk()
    for (const key of ['legend-fork', 'legend-merge', 'legend-shared', 'legend-job', 'legend-event']) {
      assert.ok(byKey(nodes, `${key}-t`) !== undefined, `图例应有 ${key} 的文字`)
      assert.ok(byKey(nodes, `${key}-g`) !== undefined || byKey(nodes, `${key}-g1`) !== undefined, `图例应有 ${key} 的图形`)
    }
    // 文案走 i18n key（桩里 t(key)=key），五个键都得在字典里（见下方双语测试）。
    for (const key of ['graph.legendFork', 'graph.legendMerge', 'graph.legendSharedFact', 'graph.legendJob', 'graph.legendEvent']) {
      assert.match(textOf(nodes), new RegExp(key.replaceAll('.', '\\.'), 'u'), `图例文案 ${key} 应渲染`)
    }
    // 位置：图例在最近轮次标记正下方，仍在头部区（第一行 y=18，内容区从 padTop 起）。
    const win = byKey(nodes, 'turn-window')
    const legendText = byKey(nodes, 'legend-fork-t')
    assert.ok(win.props.y < legendText.props.y && legendText.props.y <= 40, '图例一行贴着最近轮次标记')
  } finally {
    await ctx.cleanup()
  }
})

test('鱼骨：无往来且无汇回/放弃时泳道区一行淡字；有往来或有归档就不显示', async () => {
  // 夹具一：两条安静的线（无共享事实、无 merge/abandon）→ 空态在场。
  const ctx1 = await fixture()
  try {
    await ctx1.engine.observe({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '两条安静的线' }] } })
    const b1 = await ctx1.engine.openBranch({ label: '甲线', summary: '各走各的' })
    ctx1.advance(7000)
    await ctx1.engine.openBranch({ label: '乙线', summary: '各走各的' })
    await ctx1.engine.queue
    let snapshot = ctx1.engine.backstageSnapshot()
    assert.deepEqual(snapshot.graph.links, [])
    let nodes = loadViews({ snapshot }).walk()
    const empty = byAttr(nodes, 'data-miopiik-no-links', '1')
    assert.ok(empty !== undefined, '空态淡字应在场')
    assert.match(String(empty.children[0]), /graph\.noLinks/u)
    // 淡字落在泳道区（脊右侧的泳道带内），且比正文淡。
    assert.ok(empty.props.x > 96, '空态在泳道区，不在左脊')
    assert.equal(empty.props.opacity < 1, true)
    // 汇回一条（仍无共享事实）→ 空态消失：泳道区有真内容可看。
    await ctx1.engine.mergeBranch(b1.id, { claim: '甲线有结论了' })
    await ctx1.engine.queue
    snapshot = ctx1.engine.backstageSnapshot()
    nodes = loadViews({ snapshot }).walk()
    assert.equal(byAttr(nodes, 'data-miopiik-no-links', '1'), undefined, '有汇回事件就不显示空态')
  } finally {
    await ctx1.cleanup()
  }
  // 夹具二：有共享事实往来 → 从头就不显示空态。
  const ctx2 = await fixture()
  try {
    await ctx2.engine.addFact({ claim: '共享的事实', provenance: ['test'], conf: 'mid' })
    ctx2.advance(7000)
    await ctx2.engine.openBranch({ label: '甲线', summary: '共享 F-1', facts: ['F-1'] })
    ctx2.advance(7000)
    await ctx2.engine.openBranch({ label: '乙线', summary: '共享 F-1', facts: ['F-1'] })
    await ctx2.engine.queue
    const snapshot = ctx2.engine.backstageSnapshot()
    assert.equal(snapshot.graph.links.length, 1)
    const nodes = loadViews({ snapshot }).walk()
    assert.equal(byAttr(nodes, 'data-miopiik-no-links', '1'), undefined, '有往来就不显示空态')
  } finally {
    await ctx2.cleanup()
  }
})

test('鱼骨：选中分支（细节面板展开）时整图缩宽适配列宽，viewBox 不变，收起复原', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    const snapshot = ctx.engine.backstageSnapshot()
    const load = loadViews({ snapshot })
    const svgOf = (nodes) => nodes.find((node) => node.type === 'svg')
    let nodes = load.walk()
    const closed = svgOf(nodes)
    const W = closed.props.width
    const H = closed.props.height
    assert.equal(typeof W, 'number', '未选中时 svg 是定宽像素值（现状）')
    assert.equal(closed.props.viewBox, `0 0 ${W} ${H}`)
    // 展开细节面板：svg 缩宽（width:100%、高度按宽高比随动），viewBox 原样。
    byKey(nodes, 'e-fork:B-1').props.onClick()
    nodes = load.walk()
    assert.ok(byAttr(nodes, 'data-miopiik-branch-detail', 'B-1') !== undefined, '细节面板已展开')
    const open = svgOf(nodes)
    assert.equal(open.props.viewBox, `0 0 ${W} ${H}`, 'viewBox 不变')
    assert.equal(open.props.width, '100%', '宽度交给容器自适应')
    assert.equal(open.props.height, undefined, '高度不再写死')
    assert.equal(open.props.style.height, 'auto')
    assert.equal(open.props.style.aspectRatio, `${W} / ${H}`, '高度按宽高比随动')
    // 缩宽态的悬停气泡用百分比坐标钉在画布上。
    byAttr(nodes, 'data-miopiik-shared-fact', 'F-1').props.onMouseEnter()
    nodes = load.walk()
    const bubble = nodes.find((node) => node.props?.style?.boxShadow === '0 6px 20px rgba(0,0,0,0.12)')
    assert.ok(bubble !== undefined)
    assert.match(String(bubble.props.style.left), /%$/u, '缩宽态气泡 left 是百分比')
    assert.match(String(bubble.props.style.top), /%$/u, '缩宽态气泡 top 是百分比')
    // 收起面板：回到定宽像素（现状行为），气泡坐标回到像素。
    byKey(nodes, 'e-fork:B-1').props.onClick()
    nodes = load.walk()
    const reopened = svgOf(nodes)
    assert.equal(reopened.props.width, W)
    assert.equal(reopened.props.height, H)
    assert.equal(typeof reopened.props.style.aspectRatio, 'undefined')
    const bubble2 = nodes.find((node) => node.props?.style?.boxShadow === '0 6px 20px rgba(0,0,0,0.12)')
    assert.equal(typeof bubble2.props.style.left, 'number', '复原态气泡 left 是像素')
  } finally {
    await ctx.cleanup()
  }
})

test('鱼骨新增文案键在 zh/en 两本字典里都齐（图例 + 空态）', () => {
  const source = readFileSync(clientPath, 'utf8')
  const zhStart = source.indexOf('const zh = {')
  const enStart = source.indexOf('const en = {')
  const enEnd = source.indexOf('return {', enStart)
  assert.ok(zhStart > 0 && enStart > zhStart && enEnd > enStart)
  const zhBlock = source.slice(zhStart, enStart)
  const enBlock = source.slice(enStart, enEnd)
  const keys = [
    'graph.legendFork', 'graph.legendMerge', 'graph.legendSharedFact', 'graph.legendJob', 'graph.legendEvent',
    'graph.noLinks',
  ]
  for (const key of keys) {
    assert.ok(zhBlock.includes(`'${key}':`), `zh 缺 ${key}`)
    assert.ok(enBlock.includes(`'${key}':`), `en 缺 ${key}`)
  }
  // 中文文案就是契约点名的两句。
  assert.ok(zhBlock.includes("'graph.noLinks': '两线之间暂无往来'"))
  assert.ok(zhBlock.includes("'graph.legendSharedFact': '横虚线+小方块=共享事实'"))
})

test('清单 tab 照旧消费投影键，干预按钮仍走命令通道', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    const snapshot = ctx.engine.backstageSnapshot()
    const remote = makeRemote(ctx.engine)
    const load = loadViews({ snapshot, remote })
    const nodes = toTab(load, 'tab.list')
    for (const label of ['tab.loops', 'tab.facts', 'tab.running', 'tab.drafts', 'tab.letter']) {
      assert.ok(nodes.some((node) => String(node.children?.[0] ?? '') === label && node.type === 'span'), `${label} 卡片要在`)
    }
    // 干预按钮：一条逻辑两个调用方里的「用户走界面」这条腿没断。
    const close = buttonByText(nodes, 'loops.close')
    assert.ok(close !== undefined)
    close.props.onClick()
    await flush()
    assert.ok(remote.lines.includes('/miopiik loop close L-1'))
  } finally {
    await ctx.cleanup()
  }
})

test('三视图新增文案键在 zh/en 两本字典里都齐（双语不漏）', () => {
  const source = readFileSync(clientPath, 'utf8')
  const zhStart = source.indexOf('const zh = {')
  const enStart = source.indexOf('const en = {')
  const enEnd = source.indexOf('return {', enStart)
  assert.ok(zhStart > 0 && enStart > zhStart && enEnd > enStart)
  const zhBlock = source.slice(zhStart, enStart)
  const enBlock = source.slice(enStart, enEnd)
  const keys = [
    'ctx.l3', 'ctx.l3Expand', 'ctx.l3Collapse', 'ctx.facts', 'ctx.loops', 'ctx.inbox', 'ctx.trace', 'ctx.suggestedClose',
    'ctx.assembly', 'ctx.assemblyExpand', 'ctx.assemblyCollapse', 'ctx.assemblyHint',
    'graph.recentTurns', 'graph.allTurns', 'graph.spineTurns', 'graph.sharedFact', 'graph.sharedFactHint',
    'graph.abandoned', 'graph.open', 'graph.state', 'graph.stopReason', 'graph.contract', 'graph.closure',
    'stream.earlier', 'stream.busy', 'stream.exhausted', 'stream.tailHint', 'stream.tailOnly',
    'stream.noChannel', 'stream.badPage', 'stream.loaded', 'stream.clearTrace',
  ]
  for (const key of keys) {
    assert.ok(zhBlock.includes(`'${key}':`), `zh 缺 ${key}`)
    assert.ok(enBlock.includes(`'${key}':`), `en 缺 ${key}`)
  }
  // 契约样本点名的两个标记必须在源里。
  assert.ok(source.includes("'data-miopiik-l3-text'"))
  assert.ok(source.includes("'data-miopiik-shared-fact'"))
})

test('游标形状：{before,beforeSeq,day} 续翻与 {day} 跳翻都走命令通道', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx, { fillerFacts: 45 })
    ctx.advance(DAY)
    await ctx.engine.addFact({ claim: '第二天的结论', provenance: ['test'], conf: 'mid' })
    await ctx.engine.queue
    const remote = makeRemote(ctx.engine)
    const run = async (line) => {
      const outcome = await remote.commands.execute('session-1', line, [])
      assert.equal(outcome.ok, true)
      return JSON.parse(outcome.value.result.text)
    }
    // 游标模式：第一页 → nextCursor 是 {before, beforeSeq, day}。
    const page1 = await run('/miopiik audit limit=50')
    assert.equal(page1.rows.length, 50)
    assert.ok(page1.nextCursor.before !== undefined && page1.nextCursor.beforeSeq !== undefined && page1.nextCursor.day !== undefined)
    // 续翻到最早：游标行拼出的命令行与 host 直取等价。
    const page2 = await run(`/miopiik audit before=${page1.nextCursor.before} beforeSeq=${page1.nextCursor.beforeSeq} limit=50`)
    assert.equal(page2.nextCursor, null, '翻完游标为空，不凭空造行')
    // 按天模式：当天翻完 → nextCursor = {day}（更早一天）或空。
    const day = page1.rows[0].day
    const dayPage = await run(`/miopiik audit day=${day} limit=200`)
    assert.ok(dayPage.rows.every((row) => row.day === day))
    assert.ok(dayPage.nextCursor === null || dayPage.nextCursor.day !== undefined, '按天的 nextCursor 只带 day')
  } finally {
    await ctx.cleanup()
  }
})
