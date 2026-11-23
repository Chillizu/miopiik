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
        if (
          name === 'conversation.view' ||
          name === 'plugins.bundle.config' ||
          name === 'tool.call.toolview' ||
          name === 'conversation.chat.commandview'
        ) {
          callback()
        }
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

// ── 对话手笔（§13.11）：工具行与命令行 ────────────────────────────────

const slotByKey = (slots, name, key) => slots.find((slot) => slot.meta.name === name && slot.meta.key === key)
const renderSlot = (load, name, key, props) => {
  const entry = slotByKey(load.slots, name, key)
  assert.ok(entry !== undefined, `missing slot ${name}:${key}`)
  return load.stub.render(entry.render(props))
}
const textBlock = (value) => [{ type: 'text', text: JSON.stringify(value) }]
const disclosure = (expanded) => () => ({ expanded, toggle() {}, setExpanded() {} })
/** 一条工具调用的三个阶段形状（与 Chat 的 ToolCallOwnerProps 同：props.phase + block）。 */
const toolProps = ({ toolName, phase = 'result', args = {}, value = undefined, isError = false, errorText = '', expanded = false }) => ({
  toolName,
  phase,
  block: {
    kind: phase === 'result' ? 'tool-result' : 'tool-call',
    name: toolName,
    args,
    content: phase === 'result' ? (isError ? [{ type: 'text', text: errorText }] : textBlock(value)) : [],
    isError,
  },
  useDisclosure: disclosure(expanded),
  openFile() {},
})
const commandProps = ({ args = null, outcome }) => ({ node: { name: 'miopiik', args, outcome } })

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
    let nodes = toTab(load, 'tab.context')
    // L3 原文默认收起（所见页先给结论与悬案，原文点开才逐字展开）。
    assert.equal(byAttr(nodes, 'data-miopiik-l3-text', '1'), undefined, '默认收起')
    buttonByText(nodes, 'ctx.l3Expand').props.onClick()
    nodes = load.walk()
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
    let nodes = toTab(load, 'tab.context')
    buttonByText(nodes, 'ctx.l3Expand').props.onClick()
    nodes = load.walk()
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

test('鱼骨：图例在画布外的一行工具条——接出/接回/共享事实/方/圆，附轮次窗口', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    const snapshot = ctx.engine.backstageSnapshot()
    const load = loadViews({ snapshot })
    const nodes = load.walk()
    // 图例是 HTML 工具条（不在 SVG viewBox 里）：窄列自动换行，不被画布宽度切边。
    assert.ok(byAttr(nodes, 'data-miopiik-legend', 'graph') !== undefined, '应有图例工具条')
    for (const key of ['fork', 'merge', 'shared', 'job', 'event', 'mind']) {
      assert.ok(byAttr(nodes, 'data-miopiik-legend-item', key) !== undefined, `图例应有 ${key} 项`)
    }
    assert.equal(byAttr(nodes, 'data-miopiik-legend-item', 'fork').type, 'span', '图例项是 HTML 元素')
    // 轮次窗口也在工具条里（原来画在 SVG 头部第一行）。
    assert.ok(nodes.some((node) => node.props?.['data-miopiik-window'] !== undefined), '轮次窗口在场')
    // 文案走 i18n key（桩里 t(key)=key），图形保持内联 SVG。
    for (const key of ['graph.legendFork', 'graph.legendMerge', 'graph.legendSharedFact', 'graph.legendJob', 'graph.legendEvent']) {
      assert.match(textOf(nodes), new RegExp(key.replaceAll('.', '\\.'), 'u'), `图例文案 ${key} 应渲染`)
    }
    assert.ok(!nodes.some((node) => typeof node.props?.key === 'string' && node.props.key.startsWith('legend-')), '旧的内联 SVG 图例字形已撤')
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
    const svgOf = (nodes) => nodes.find((node) => node.props?.['data-miopiik-graph'] === '1')
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

// ── Mind 署名三处落地（§13.10）：鱼骨 Mind 泳道 / 流水行面小签 / 所见折叠段 ──

test('鱼骨：Mind 泳道——脊右分支左、菱形节点、悬停 label+refs+时间、点击跳流水溯源', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    const snapshot = ctx.engine.backstageSnapshot()
    assert.ok(snapshot.graph.mindEvents.length >= 6, '夹具要有 mind 署名行')
    const remote = makeRemote(ctx.engine)
    const load = loadViews({ snapshot, remote })
    const nodes = load.walk()
    // 泳道标题在场（i18n 键），基线是虚线细道。
    assert.match(textOf(nodes), /graph\.mindLane/u)
    const lane = byKey(nodes, 'mindlane')
    assert.ok(lane !== undefined, 'Mind 泳道基线在场')
    assert.equal(lane.props.strokeDasharray, '2 4')
    // 菱形节点：与圆/方都不同形（path 四顶点）、主色描边，落在脊右分支左。
    const dispatch = byAttr(nodes, 'data-miopiik-mind-node', 'job.dispatch:J-1')
    assert.ok(dispatch !== undefined, '派发 J-1 的菱形应在 Mind 泳道')
    assert.match(String(dispatch.props.d), /^M \d+(?:\.\d+)?,-?\d+(?:\.\d+)? L .* Z$/u, '菱形是四顶点闭合 path')
    const cx = Number(/^M (\d+(?:\.\d+)?),/.exec(String(dispatch.props.d))[1])
    const fork1 = byKey(nodes, 'e-fork:B-1')
    assert.ok(cx > 246, 'Mind 泳道在分支泳道区右侧的独立窄道')
    assert.ok(cx > fork1.props.cx, 'Mind 泳道在分支泳道右侧（行内用户原话让出脊右位置）')
    assert.equal((String(dispatch.props.d).match(/ L /gu) || []).length, 3, '菱形四段闭合')
    assert.ok(String(dispatch.props.stroke).includes('--dsw-static-deepseek-500'), '主色描边')
    assert.equal(dispatch.props.style.cursor, 'pointer')
    // 并回 / 闭合 / 开线都在：契约样例的手笔按时间落点。
    for (const key of ['branch.merge:B-1', 'loop.add:L-1', 'branch.fork:B-1', 'branch.abandon:B-2']) {
      assert.ok(nodes.some((node) => node.props?.['data-miopiik-mind-node'] === key), `${key} 应有菱形节点`)
    }
    // 悬停：气泡给 label + refs + 时间 + 说明。
    dispatch.props.onMouseEnter()
    const hovered = load.walk()
    const bubble = hovered.find((node) => node.props?.style?.boxShadow === '0 6px 20px rgba(0,0,0,0.12)')
    assert.ok(bubble !== undefined, '悬停出气泡')
    const bubbleText = bubble.children.map((child) => String(child.children?.[0] ?? '')).join(' ')
    assert.match(bubbleText, /派发 J-1/u)
    assert.match(bubbleText, /refs: J-1 L-1/u)
    assert.match(bubbleText, /graph\.mindHint/u)
    assert.ok(!Number.isNaN(new Date(String(bubble.children[2]?.children?.[0] ?? '')).getTime()), '气泡带时间')
    hovered.find((node) => node.props?.['data-miopiik-mind-node'] === 'job.dispatch:J-1').props.onMouseLeave()
    // 点击：跳流水溯源（走既有 traceId 通道，服务端无过滤、本地按 J-1 匹配）。
    dispatch.props.onClick()
    const traced = await settleTrace(load)
    const rows = displayedRows(traced)
    assert.ok(rows.some((row) => row.kind === 'job.dispatch'), '溯源到派发行')
    assert.ok(rows.some((row) => row.kind === 'job.update'), '该对象的执行层落账也在')
    assert.match(textOf(traced), /J-1 ×/u, '溯源过滤片在场')
  } finally {
    await ctx.cleanup()
  }
})

test('鱼骨：图例含「菱形=Mind 动作」，且图例在画布外不压任何事件节点', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    const snapshot = ctx.engine.backstageSnapshot()
    const load = loadViews({ snapshot })
    const nodes = load.walk()
    // 菱形项在工具条里，文案是 §13.10 的「菱形=Mind 动作」。
    assert.ok(byAttr(nodes, 'data-miopiik-legend-item', 'mind') !== undefined, '图例要有 Mind 菱形项')
    assert.match(textOf(nodes), /graph\.legendMind/u)
    // 图例不再占用 viewBox：画布首行从头部标题（y=18）之下起，指针节点都落在 padTop 之后。
    const topEdgeOf = (node) => {
      if (node.props.cy !== undefined) return Number(node.props.cy) - 8
      if (node.props.y !== undefined) return Number(node.props.y)
      const hit = /^M \d+(?:\.\d+)?,(\d+(?:\.\d+)?)/.exec(String(node.props.d ?? ''))
      return hit === null ? Infinity : Number(hit[1])
    }
    const rect = (node) => Number(node.props.y ?? 0)
    const pointerNodes = nodes.filter((node) => node.props?.style?.cursor === 'pointer' && Number.isFinite(topEdgeOf(node)))
    assert.ok(pointerNodes.length >= 5, '夹具要有指针节点')
    for (const node of pointerNodes) {
      const top = node.type === 'rect' ? rect(node) : topEdgeOf(node)
      assert.ok(top > 24, `节点顶边 y=${top} 应在画布头部标题之下`)
    }
    // 画布本身带 data 标记，缩宽/正常两态都能按它取到图表 SVG。
    assert.ok(nodes.some((node) => node.props?.['data-miopiik-graph'] === '1'), '图表 SVG 有标记')
  } finally {
    await ctx.cleanup()
  }
})

test('鱼骨：缩宽态头部不遮挡——视图自提一层越过壳宽柄条带', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    const snapshot = ctx.engine.backstageSnapshot()
    const load = loadViews({ snapshot })
    const nodes = load.walk()
    // 实测病灶：aside 展开整图缩宽后，顶部事件节点落进 DSH 会话壳的隐形 col-resize
    // 宽柄（.wSkVaW_widthHandle，position:absolute、z-index:0，纵贯整列），
    // 点击/悬停全被它吃掉。修法是本视图根自提 position+zIndex 越过它：壳元素一个不改。
    const root = nodes[0]
    assert.ok(root !== undefined && root.type === 'div', 'walk 首节点是视图根')
    assert.equal(root.props.style.position, 'relative', '视图根建层')
    assert.equal(root.props.style.zIndex, 1, '越过壳宽柄的 z-index:0')
    // 缩宽契约不回归：aside 展开仍是 viewBox 不变、width:100%、高度随宽高比。
    byKey(nodes, 'e-fork:B-1').props.onClick()
    const opened = load.walk()
    assert.ok(byAttr(opened, 'data-miopiik-branch-detail', 'B-1') !== undefined, '细节面板已展开（缩宽态）')
    const svg = opened.find((node) => node.props?.['data-miopiik-graph'] === '1')
    assert.equal(svg.props.width, '100%')
    assert.equal(svg.props.style.aspectRatio, `${svg.props.viewBox.split(' ')[2]} / ${svg.props.viewBox.split(' ')[3]}`)
    // 缩宽态下每个指针节点都还在场（几何由画布负责，命中由根层负责）。
    assert.ok(opened.filter((node) => node.props?.style?.cursor === 'pointer').length >= 5)
  } finally {
    await ctx.cleanup()
  }
})

test('流水：行面 actor 小签——不用点开行详情即可辨认手笔，三色走主题变量', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    const snapshot = ctx.engine.backstageSnapshot()
    const load = loadViews({ snapshot })
    const nodes = toTab(load, 'tab.stream')
    const rows = rowNodes(nodes)
    assert.ok(rows.length >= 7, '尾窗行在场')
    // 每行行尾都带小签；行内前三格（时间/kind/结论）次序不动。
    // 小签是函数组件：桩里 walk 会摊平渲染产物，这里按组件本体调用取它产出的 span。
    const chipOf = (row) => {
      const last = row.children.at(-1)
      return typeof last?.type === 'function' ? last.type(last.props) : last
    }
    for (const row of rows) {
      const chip = chipOf(row)
      assert.ok(chip?.props?.['data-miopiik-actor'] !== undefined, '行面应有 actor 小签')
      assert.equal(typeof row.children[1]?.children?.[0], 'string', 'kind 格不动')
      assert.equal(typeof row.children[2]?.children?.[0], 'string', '结论格不动')
    }
    const chips = rows.map(chipOf)
    const actors = chips.map((chip) => chip.props['data-miopiik-actor'])
    assert.ok(actors.includes('ink') && actors.includes('mind') && actors.includes('operator'), '尾窗三署名都可见')
    // 三色走 C.* 主题变量：mind=品牌蓝、ink=中性、operator=琥珀。
    const colorOf = (actor) => chips[actors.indexOf(actor)].props.style.color
    assert.match(String(colorOf('mind')), /--dsw-static-deepseek-500/u)
    assert.equal(String(colorOf('ink')), 'var(--dsw-alias-label-secondary)')
    assert.match(String(colorOf('operator')), /--dsw-alias-state-warn-primary/u)
    // 小签文本走 i18n 键，悬停说明走 hint 键。
    assert.match(String(chips[actors.indexOf('mind')].children[0]), /^actor\.mind$/u)
    assert.match(String(chips[actors.indexOf('mind')].props.title), /^actor\.mindHint$/u)
    assert.match(String(chips[actors.indexOf('ink')].props.title), /^actor\.inkHint$/u)
    assert.match(String(chips[actors.indexOf('operator')].props.title), /^actor\.operatorHint$/u)
    // 行详情里的既有 actor 保留：点开一行 ink 署名的行核对。
    const inkRow = rows[actors.indexOf('ink')]
    inkRow.props.onClick()
    const detail = load.walk()
    assert.match(textOf(detail), /actor: ink/u)
  } finally {
    await ctx.cleanup()
  }
})

test('所见：「Mind 最近动作」折叠段默认收起，展开后最近 8 条 kind+label+时间', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    const snapshot = ctx.engine.backstageSnapshot()
    const mindEvents = snapshot.graph.mindEvents
    assert.ok(mindEvents.length >= 8, '夹具要够 8 条 mind 署名行')
    const load = loadViews({ snapshot })
    let nodes = toTab(load, 'tab.context')
    // 折叠段在场、默认收起：标题在，行不在。
    assert.match(textOf(nodes), /ctx\.mind/u)
    assert.match(textOf(nodes), /ctx\.mindHint/u)
    assert.equal(nodes.some((node) => node.props?.['data-miopiik-mind-row'] !== undefined), false, '默认收起不倒明细')
    assert.doesNotMatch(textOf(nodes), /派发 J-1/u)
    const expand = buttonByText(nodes, 'ctx.mindExpand')
    assert.ok(expand !== undefined)
    expand.props.onClick()
    nodes = load.walk()
    // 展开：最近 8 条、新者在前，kind+label 与快照同源。
    const shown = nodes.filter((node) => node.props?.['data-miopiik-mind-row'] !== undefined)
    assert.equal(shown.length, Math.min(8, mindEvents.length))
    const expected = mindEvents.slice(-8).reverse()
    assert.deepEqual(
      shown.map((node) => node.props['data-miopiik-mind-row']),
      expected.map((row) => `${row.kind}:${row.id}`),
    )
    assert.match(textOf(nodes), /job\.dispatch/u)
    assert.match(textOf(nodes), /派发 J-1/u)
    assert.match(textOf(nodes), /并回 B-1/u)
    // 每行带时间。
    for (const node of shown) {
      const timeText = String(node.children[2]?.children?.[0] ?? '')
      assert.ok(!Number.isNaN(new Date(timeText).getTime()), '行内时间可读')
    }
    // L3 原文块逐字不动（默认收起，点开才渲染）。
    buttonByText(nodes, 'ctx.l3Expand').props.onClick()
    nodes = load.walk()
    assert.equal(byAttr(nodes, 'data-miopiik-l3-text', '1').children[0], snapshot.l3.text)
  } finally {
    await ctx.cleanup()
  }
})

test('Mind 署名相关文案键在 zh/en 两本字典里都齐', () => {
  const source = readFileSync(clientPath, 'utf8')
  const zhStart = source.indexOf('const zh = {')
  const enStart = source.indexOf('const en = {')
  const enEnd = source.indexOf('return {', enStart)
  assert.ok(zhStart > 0 && enStart > zhStart && enEnd > enStart)
  const zhBlock = source.slice(zhStart, enStart)
  const enBlock = source.slice(enStart, enEnd)
  const keys = [
    'graph.legendMind', 'graph.mindLane', 'graph.mindHint',
    'actor.mind', 'actor.ink', 'actor.operator', 'actor.user',
    'actor.mindHint', 'actor.inkHint', 'actor.operatorHint',
    'ctx.mind', 'ctx.mindExpand', 'ctx.mindCollapse', 'ctx.mindHint',
  ]
  for (const key of keys) {
    assert.ok(zhBlock.includes(`'${key}':`), `zh 缺 ${key}`)
    assert.ok(enBlock.includes(`'${key}':`), `en 缺 ${key}`)
  }
  // 契约点名的两句必须逐字在（图例一行 / 折叠段标题）。
  assert.ok(zhBlock.includes("'graph.legendMind': '菱形=Mind 动作'"))
  assert.ok(zhBlock.includes("'ctx.mind': 'Mind 最近动作'"))
  assert.ok(enBlock.includes("'graph.legendMind': 'diamond = Mind action'"))
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

// ── 对话手笔（§13.11）：14 个 ink_* 工具行 + miopiik 命令行 ─────────────

test('对话手笔：14 个 ink_* 工具行与 miopiik 命令行都接管了对应席位', async () => {
  const ctx = await fixture()
  try {
    const load = loadViews({ snapshot: ctx.engine.backstageSnapshot() })
    const names = [
      'ink_status', 'ink_loops', 'ink_facts', 'ink_inbox', 'ink_dispatch', 'ink_commit', 'ink_brief',
      'ink_epoch', 'ink_draft', 'ink_ask', 'ink_report', 'ink_branch', 'ink_fold', 'ink_recall',
    ]
    for (const name of names) {
      assert.ok(slotByKey(load.slots, 'tool.call.toolview', name) !== undefined, `缺工具行席位：${name}`)
    }
    assert.ok(slotByKey(load.slots, 'conversation.chat.commandview', 'miopiik') !== undefined, '缺 miopiik 命令行席位')
    // 只接管自己的：别人的工具名不该被抢。
    assert.equal(slotByKey(load.slots, 'tool.call.toolview', 'bash'), undefined)
  } finally {
    await ctx.cleanup()
  }
})

test('工具行：折叠态是人话（名词 · 动词 对象），不再是参数 JSON', async () => {
  const ctx = await fixture()
  try {
    const load = loadViews({ snapshot: ctx.engine.backstageSnapshot() })
    const nodes = renderSlot(load, 'tool.call.toolview', 'ink_loops', toolProps({
      toolName: 'ink_loops',
      args: { action: 'close', id: 'L-33' },
      value: { loop: { id: 'L-33', text: '三视图收口', status: 'closed' } },
    }))
    const row = byAttr(nodes, 'data-miopiik-tool-row', 'ink_loops')
    assert.ok(row !== undefined, '应有工具行')
    assert.equal(row.props['data-state'], 'ok')
    const text = textOf(nodes)
    assert.match(text, /ink\.noun\.loops/u, '名词走 i18n')
    assert.match(text, /ink\.act\.close/u, '动词走 i18n')
    assert.match(text, /L-33/u, '对象在场')
    assert.ok(!text.includes('{"action"'), '不再露参数 JSON')
    // 折叠态不倒正文。
    assert.equal(byAttr(nodes, 'data-miopiik-tool-body', 'ink_loops'), undefined)
  } finally {
    await ctx.cleanup()
  }
})

test('工具行：展开是结构化正文——契约字段逐行、结果摊开，不回灌 JSON', async () => {
  const ctx = await fixture()
  try {
    const load = loadViews({ snapshot: ctx.engine.backstageSnapshot() })
    const nodes = renderSlot(load, 'tool.call.toolview', 'ink_dispatch', toolProps({
      toolName: 'ink_dispatch',
      args: { goal: '把三视图改漂亮', budget: '一次派发', boundary: '不动 host 契约' },
      value: { jobId: 'J-12', provider: 'opencode-go/glm-5.3' },
      expanded: true,
    }))
    const body = byAttr(nodes, 'data-miopiik-tool-body', 'ink_dispatch')
    assert.ok(body !== undefined, '展开后有正文')
    const text = textOf(nodes)
    assert.match(text, /ink\.field\.goal/u)
    assert.match(text, /把三视图改漂亮/u)
    assert.match(text, /ink\.field\.budget/u)
    assert.match(text, /J-12/u)
    assert.ok(!text.includes('{"goal"'), '正文不是 JSON 原文')
    assert.ok(!text.includes('{"jobId"'), '结果也不回灌 JSON')
  } finally {
    await ctx.cleanup()
  }
})

test('工具行：ink_status 展开是一屏账（指标行），不摊 session 号这类内部字段', async () => {
  const ctx = await fixture()
  try {
    const load = loadViews({ snapshot: ctx.engine.backstageSnapshot() })
    const nodes = renderSlot(load, 'tool.call.toolview', 'ink_status', toolProps({
      toolName: 'ink_status',
      value: {
        session: 'session-内部编号',
        turn: 26,
        epoch: 1,
        day: 20779,
        observations: 715,
        loops: { active: 1, dormant: 0, folded: 0, closed: 32, cap: 12 },
        facts: { active: 44, stale: 8 },
        inbox: { pending: 0 },
        notes: 37,
      },
      expanded: true,
    }))
    const text = textOf(nodes)
    assert.match(text, /ink\.status\.active/u)
    assert.match(text, /ink\.status\.stale/u)
    assert.match(text, /T26 \u00b7 D20779 \u00b7 E1/u)
    assert.ok(!text.includes('session-内部编号'), '内部 session 号不上屏')
  } finally {
    await ctx.cleanup()
  }
})

test('工具行：进行中与失败态各说各话——不把错误塞进正文冒充结果', async () => {
  const ctx = await fixture()
  try {
    const load = loadViews({ snapshot: ctx.engine.backstageSnapshot() })
    const running = renderSlot(load, 'tool.call.toolview', 'ink_recall', toolProps({
      toolName: 'ink_recall',
      phase: 'preparing',
      args: { query: '图例' },
      expanded: false,
    }))
    assert.equal(byAttr(running, 'data-miopiik-tool-row', 'ink_recall').props['data-state'], 'running')
    assert.match(textOf(running), /ink\.row\.preparing/u)

    const failed = renderSlot(load, 'tool.call.toolview', 'ink_commit', toolProps({
      toolName: 'ink_commit',
      args: { title: '交卷' },
      isError: true,
      errorText: '无人值守不 commit：本轮没有用户输入。',
    }))
    const row = byAttr(failed, 'data-miopiik-tool-row', 'ink_commit')
    assert.equal(row.props['data-state'], 'error')
    assert.match(textOf(failed), /ink\.row\.failed/u)
    assert.match(textOf(failed), /无人值守不 commit/u)
  } finally {
    await ctx.cleanup()
  }
})

test('命令行：审计翻页只报「翻了多少」，整页 JSON 不进对话', async () => {
  const ctx = await fixture()
  try {
    const load = loadViews({ snapshot: ctx.engine.backstageSnapshot() })
    const page = { rows: [{ id: 'A-1' }, { id: 'A-2' }, { id: 'A-3' }], nextCursor: { before: 1, beforeSeq: 2 } }
    const nodes = renderSlot(load, 'conversation.chat.commandview', 'miopiik', commandProps({
      args: null,
      outcome: { kind: 'success', text: JSON.stringify(page) },
    }))
    assert.ok(byAttr(nodes, 'data-miopiik-cmd-row', 'audit') !== undefined, '命令行认成审计翻页')
    const text = textOf(nodes)
    assert.match(text, /ink\.cmd\.audit/u)
    assert.match(text, /3 ink\.cmd\.rows/u)
    assert.ok(!text.includes('{"rows"'), '整页 JSON 不再灌进对话')
    assert.ok(!text.includes('nextCursor'), '游标也不上屏')
  } finally {
    await ctx.cleanup()
  }
})

test('命令行：干预动作照抄那句人话，出错才红着说', async () => {
  const ctx = await fixture()
  try {
    const load = loadViews({ snapshot: ctx.engine.backstageSnapshot() })
    const ok = renderSlot(load, 'conversation.chat.commandview', 'miopiik', commandProps({
      args: null,
      outcome: { kind: 'success', text: '已划掉 L-33' },
    }))
    assert.match(textOf(ok), /已划掉 L-33/u)
    const bad = renderSlot(load, 'conversation.chat.commandview', 'miopiik', commandProps({
      args: null,
      outcome: { kind: 'error', text: '没有这条开环: L-99' },
    }))
    assert.match(textOf(bad), /没有这条开环/u)
    const dot = bad.find((node) => node.props?.style?.background !== undefined && node.props.style.borderRadius === 3)
    assert.match(String(dot.props.style.background), /--dsw-alias-state-error-primary/u, '失败点走错误色')
  } finally {
    await ctx.cleanup()
  }
})

test('对话手笔文案键在 zh/en 两本字典里都齐', () => {
  const source = readFileSync(clientPath, 'utf8')
  const zhStart = source.indexOf('const zh = {')
  const enStart = source.indexOf('const en = {')
  const enEnd = source.indexOf('return {', enStart)
  const zhBlock = source.slice(zhStart, enStart)
  const enBlock = source.slice(enStart, enEnd)
  const keys = [
    'ink.noun.status', 'ink.noun.loops', 'ink.noun.facts', 'ink.noun.inbox', 'ink.noun.dispatch',
    'ink.noun.commit', 'ink.noun.brief', 'ink.noun.epoch', 'ink.noun.draft', 'ink.noun.ask',
    'ink.noun.report', 'ink.noun.branch', 'ink.noun.fold', 'ink.noun.recall',
    'ink.row.failed', 'ink.row.preparing', 'ink.row.running', 'ink.row.count', 'ink.row.approved', 'ink.row.rejected',
    'ink.cmd.audit', 'ink.cmd.rows', 'ink.cmd.loopClose', 'ink.cmd.loopDrop', 'ink.cmd.factInvalidate',
    'ink.field.goal', 'ink.field.claim', 'ink.field.archive', 'ink.field.read',
    'ink.status.active', 'ink.status.closed', 'ink.status.position',
    'stream.kind.absorb', 'stream.kind.preview', 'stream.kind.fact.add',
  ]
  for (const key of keys) {
    assert.ok(zhBlock.includes(`'${key}':`), `zh 缺 ${key}`)
    assert.ok(enBlock.includes(`'${key}':`), `en 缺 ${key}`)
  }
})

test('工具行配色与 DSH 自家工具行同档：tertiary 灰、悬停提亮、语义图标各不相同', async () => {
  const ctx = await fixture()
  try {
    const load = loadViews({ snapshot: ctx.engine.backstageSnapshot() })
    const renderRow = (toolName, args, value) =>
      renderSlot(load, 'tool.call.toolview', toolName, toolProps({ toolName, args, value }))
    const tertiary = 'var(--dsw-alias-label-tertiary, #81858c)'
    const status = renderRow('ink_status', {}, { loops: { active: 1 }, facts: { active: 2 }, inbox: { pending: 0 }, notes: 1, observations: 2, turn: 1, day: 1, epoch: 0 })
    const branch = renderRow('ink_branch', { action: 'merge', id: 'B-2', claim: '并回' }, { branch: { id: 'B-2', status: 'merged' } })
    // 标题走 tertiary 灰（与 DSH 工具行同一个 token），不是正文色也不是品牌蓝。
    const titleOf = (nodes) => nodes.find((n) => n.type === 'span' && String(n.children?.[0] ?? '').startsWith('ink.noun.'))
    assert.equal(String(titleOf(status).props.style.color), tertiary)
    // 展开/悬停才提到正文色。
    const rowRoot = status.find((n) => n.props?.['data-miopiik-tool-row'] !== undefined)
    rowRoot.props.onMouseEnter()
    const hovered = load.stub.render(slotByKey(load.slots, 'tool.call.toolview', 'ink_status').render(
      toolProps({ toolName: 'ink_status', value: { loops: { active: 1 }, facts: { active: 2 }, inbox: { pending: 0 }, notes: 1, observations: 2, turn: 1, day: 1, epoch: 0 } }),
    ))
    assert.equal(String(hovered.find((n) => n.type === 'span' && String(n.children?.[0] ?? '').startsWith('ink.noun.')).props.style.color), 'var(--dsw-alias-label-primary)')
    // 语义图标：每条工具行一个内联 SVG，描边走 currentColor（跟着灰走），形状按工具不同。
    const svgOf = (nodes) => nodes.find((n) => n.type === 'svg' && n.props?.viewBox === '0 0 14 14')
    const statusSvg = svgOf(status)
    const branchSvg = svgOf(branch)
    assert.ok(statusSvg !== undefined && branchSvg !== undefined, '每个工具行都有图标')
    assert.equal(statusSvg.props.style.color, tertiary)
    assert.equal(statusSvg.children[0].props.stroke, 'currentColor')
    assert.notEqual(
      statusSvg.children.map((p) => p.props.d).join('|'),
      branchSvg.children.map((p) => p.props.d).join('|'),
      '不同工具图标不同形',
    )
  } finally {
    await ctx.cleanup()
  }
})

test('鱼骨：聚簇布局——一行 = 一轮，同轮动作收进同一行，画布显著变短', async () => {
  const ctx = await fixture()
  try {
    await seedLedger(ctx)
    const snapshot = ctx.engine.backstageSnapshot()
    const graph = snapshot.graph
    const load = loadViews({ snapshot })
    const nodes = load.walk()
    const svg = nodes.find((node) => node.props?.['data-miopiik-graph'] === '1')
    assert.ok(svg !== undefined, '图表 SVG 在场')
    const [, , , H] = String(svg.props.viewBox).split(' ').map(Number)
    const items = (graph.turns?.length ?? 0) + (graph.events?.length ?? 0) + (graph.mindEvents?.length ?? 0)
    assert.ok(items >= 10, '夹具要足够多条目')
    // 聚簇前每条占一行；现在一行 = 一轮，高度必须明显小于「一条一行」。
    assert.ok(H < items * 26, `画布高 ${H} 应小于「一条一行」的 ${items * 26}`)
    // 轮次圆点与菱形：同一轮的 Mind 动作落在该轮行内（不超过该轮堆叠深度）。
    const turns = [...(graph.turns ?? [])].sort((a, b) => a.at - b.at)
    const dots = new Map()
    for (const node of nodes) {
      const key = String(node.props?.key ?? '')
      if (key.startsWith('t-') && node.type === 'circle' && node.props?.fill?.includes('--dsw-static-deepseek-500')) {
        dots.set(Number(key.slice(2)), node.props.cy)
      }
    }
    const assignTurn = (at) => {
      let anchor = null
      for (const turn of turns) {
        if ((turn.at ?? 0) <= at) anchor = turn
        else break
      }
      return anchor
    }
    const mindByTurn = new Map()
    for (const event of graph.mindEvents ?? []) {
      const turn = assignTurn(event.at ?? 0)
      if (turn === null) continue
      const list = mindByTurn.get(turn.turn) ?? []
      list.push(event)
      mindByTurn.set(turn.turn, list)
    }
    let checked = 0
    for (const [turn, events] of mindByTurn) {
      const dotY = dots.get(turn)
      if (dotY === undefined) continue
      for (const event of events) {
        const diamond = nodes.find((node) => node.props?.['data-miopiik-mind-node'] === `${event.kind}:${event.id}`)
        assert.ok(diamond !== undefined, `菱形缺失：${event.kind}:${event.id}`)
        const my = Number(/ L \d+(?:\.\d+)?,(-?\d+(?:\.\d+)?)/.exec(String(diamond.props.d))[1])
        assert.ok(my >= dotY - 1, `第${turn}轮的动作不应跑到上一行（y=${my}, 轮点=${dotY}）`)
        assert.ok(my <= dotY + 12 * Math.max(0, events.length - 1) + 1, `第${turn}轮的动作应留在本行（y=${my}）`)
        checked += 1
      }
    }
    assert.ok(checked >= 4, '至少检查几条 Mind 动作')
  } finally {
    await ctx.cleanup()
  }
})
