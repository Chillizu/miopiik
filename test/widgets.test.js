import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { layoutDepth, validateWidget } from '../miopiik-dsh/host/widgets.js'
import { openStore } from '../miopiik-dsh/host/store.js'
import { Engine } from '../miopiik-dsh/host/engine.js'

test('view spec：dataset 合法，返回规范化 spec 与 fallback', () => {
  const checked = validateWidget({
    widget: 'dataset',
    title: '两种接入方式',
    props: { columns: [{ label: '维度' }, { label: '自绘' }], rows: [['成本', '低']] },
    fallback: '自绘成本低',
  })
  assert.equal(checked.ok, true)
  assert.equal(checked.spec.widget, 'dataset')
  assert.equal(checked.fallbackText, '自绘成本低')
})

test('view spec：没有 fallback 一律拒收', () => {
  const checked = validateWidget({ widget: 'text', props: { paragraphs: ['x'] } })
  assert.equal(checked.ok, false)
  assert.match(checked.errors.join(''), /fallback/)
})

test('view spec：未知 widget 报错并列出可用清单', () => {
  const checked = validateWidget({ widget: 'mermaid', props: {}, fallback: 'x' })
  assert.equal(checked.ok, false)
  assert.match(checked.errors.join(''), /未知 widget/)
  assert.ok(checked.available.includes('dataset'))
})

test('view spec：choice 最多两个动作，layout 嵌套有上限', () => {
  assert.equal(
    validateWidget({ widget: 'choice', props: { question: '要吗', actions: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] }, fallback: 'x' }).ok,
    false,
  )
  const inner = { widget: 'text', props: { paragraphs: ['深'] }, fallback: 'x' }
  const level1 = { widget: 'layout', props: { direction: 'stack', children: [inner] }, fallback: 'x' }
  const level2 = { widget: 'layout', props: { direction: 'row', children: [level1] }, fallback: 'x' }
  const level3 = { widget: 'layout', props: { direction: 'grid', children: [level2] }, fallback: 'x' }
  assert.equal(layoutDepth(level3), 3)
})

test('工具面确实接上了 widgets 模块（防漏 import）', async () => {
  const source = await readFile(new URL('../miopiik-dsh/host/tools.js', import.meta.url), 'utf8')
  assert.match(source, /import \{ WIDGET_KINDS, layoutDepth, validateWidget \} from '\.\/widgets\.js'/)
  assert.match(source, /name: 'ink_view'/)
})

test('widgets 账本：show 进快照，clear 清空', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'miopiik-widgets-'))
  try {
    const store = await openStore(join(dir, 'sessions', 'a'), 'a', { workspaceRoot: dir })
    const engine = new Engine({ store, sessionId: 'a', now: () => Date.UTC(2026, 10, 1) })
    await engine.pushWidget({ widget: 'text', title: '示例', props: { paragraphs: ['一句话'] }, fallback: '一句话' })
    await engine.queue
    assert.equal(engine.backstageSnapshot().view.widgets.length, 1)
    await engine.clearWidgets()
    await engine.queue
    assert.equal(engine.backstageSnapshot().view.widgets.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('对话正文里的卡片：由 ink_view 的 tool/call 长成 Turn 层节点，不进可折叠的过程组', async () => {
  const source = await readFile(new URL('../miopiik-dsh/client.js', import.meta.url), 'utf8')
  // 注册面：keyed 节点席位 + 事件定义
  assert.match(source, /name: 'conversation\.chat\.node', key: WIDGET_NODE_KIND/)
  assert.match(source, /uiConversation\.events\.register\(widgetNodeDefinition\)/)
  // 定义：认 ink_view 的调用事件，站在 Turn 层
  assert.match(source, /const WIDGET_NODE_KIND = 'miopiik-widget'/)
  assert.match(source, /data\.name !== 'ink_view'/)
  assert.match(source, /parsed\.action !== 'show'/)
  assert.match(source, /groupTree: 'turn'/)
  // 旧的 toolview 席位已让位：同一张卡不再在折叠区里重复出现
  assert.ok(!source.includes("'tool.call.toolview'"), '不该再挂 toolview 席位')
  assert.ok(!source.includes('function InkViewRow('), '旧的 toolview 行已移除')
})

test('渲染器：真图表与真连线，不是文字占位', async () => {
  const source = await readFile(new URL('../miopiik-dsh/client.js', import.meta.url), 'utf8')
  for (const needle of [
    'function renderGraph(',
    'function renderChart(',
    "if (kind === 'line')",
    "if (kind === 'donut')",
    "preserveAspectRatio: 'xMidYMid meet'",
    "markerEnd: 'url(#miopiik-arrow)'",
    "h('polyline', {",
    "gridTemplateColumns: '54px 14px minmax(0, 1fr)'",
  ]) {
    assert.ok(source.includes(needle), `client.js 缺少：${needle}`)
  }
  // 边不再退化成一行文字表
  assert.ok(!source.includes('edges.map((edge, index) => `${edge.from} → ${edge.to}'),'), '边表不该回到纯文字')
})
