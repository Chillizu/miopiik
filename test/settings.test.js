import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { DEFAULTS, KNOB_DOCS } from '../miopiik-dsh/host/config-defaults.js'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(join(here, '..', 'miopiik-dsh', 'client.js'), 'utf8')

/** 从 client.js 里抽出 KNOBS 表（避免多维护一份形状）。 */
function clientKnobs() {
  const start = clientSource.indexOf('const KNOBS = [')
  assert.ok(start > 0, 'client 里应存在 KNOBS')
  // 表的结尾是行首缩进的 `]`，不能取第一个 `]`（每行里都有）。
  const end = clientSource.indexOf('\n    ]', start)
  assert.ok(end > start, 'KNOBS 表应有结束括号')
  const block = clientSource.slice(start, end)
  const entries = []
  const re = /\['([^']+)',\s*'([^']*)',\s*(null|true|false|'[^']*'|\d+)\]/gu
  for (const match of block.matchAll(re)) {
    const raw = match[3]
    const value =
      raw === 'null'
        ? null
        : raw === 'true'
          ? true
          : raw === 'false'
            ? false
            : raw.startsWith("'")
              ? raw.slice(1, -1)
              : Number(raw)
    entries.push([match[1], match[2], value])
  }
  return entries
}

test('设置页列出的可调项与 host 默认值一一对应，不漂移', () => {
  const knobs = clientKnobs()
  assert.equal(knobs.length, KNOB_DOCS.length, '两边的可调项数量应一致')
  for (const [key, , value] of knobs) {
    assert.ok(key in DEFAULTS, `client 有 ${key}，host 没有`)
    assert.deepEqual(value, DEFAULTS[key], `${key} 的默认值两边不一致`)
  }
})

test('每个可调项都在 KNOB_DOCS 里有中文说明', () => {
  for (const [key] of clientKnobs()) {
    const doc = KNOB_DOCS.find((entry) => entry[0] === key)
    assert.ok(doc !== undefined, `${key} 缺说明`)
    assert.ok(doc[1].length > 0)
  }
})

test('真正用到的常量来自同一张表（改一处即全站生效）', async () => {
  const loops = await import('../miopiik-dsh/host/loops.js')
  const inbox = await import('../miopiik-dsh/host/inbox.js')
  assert.equal(loops.ACTIVE_LOOP_CAP, DEFAULTS.activeLoopCap)
  assert.equal(loops.DORMANT_AFTER_DAYS, DEFAULTS.dormantAfterDays)
  assert.equal(loops.FOLDED_AFTER_DAYS, DEFAULTS.foldedAfterDays)
  assert.equal(inbox.MAX_FULL_PREVIEWS, DEFAULTS.inboxMaxPreviews)
})

test('关键客户端注册点都在（防止替换静默失效）', () => {
  for (const needle of [
    "ctx.slots.inject('plugins.bundle.config'",
    "ctx.slots.inject('conversation.view'",
    "name: 'plugins.bundle.config'",
    "key: 'miopiik-dsh'",
    "name: 'conversation.view'",
    'function SettingsSection(',
  ]) {
    assert.ok(clientSource.includes(needle), `client.js 缺少：${needle}`)
  }
})

test('鱼骨主视图：注册在会话视图、按事件画、带悬停与详情', () => {
  for (const needle of [
    'function MiOpIIkView(',
    'function FishboneView(',
    'function CountsStrip(',
    "ctx.slots.inject('conversation.view'",
    "id: 'miopiik'",
    'graph?.events',
    'setHover',
    'setSelected',
    'tab.list',
    'tab.stream',
    'onOpenGraph',
    'function StreamPane(',
    'onOpenStream',
    'graph.openStream',
    'function ListPane(',
    'function Section(',
  ]) {
    assert.ok(clientSource.includes(needle), `client.js 缺少：${needle}`)
  }
  assert.ok(!clientSource.includes('graph.legend'), '解释性图例不该存在')
  assert.ok(!clientSource.includes("conversation.session.header.utilities"), '入口已合并，不该再占顶栏')
})

test('界面上用到的每个文案键都在字典里（防止把 key 直接渲染出来）', () => {
  const zhStart = clientSource.indexOf('const zh = {')
  const zhEnd = clientSource.indexOf('const en = {')
  const zhBlock = clientSource.slice(zhStart, zhEnd)
  const defined = new Set()
  for (const match of zhBlock.matchAll(/'([a-zA-Z0-9_.]+)':/gu)) defined.add(match[1])
  const used = new Set()
  // 前面不能紧跟字母（否则 inject('...') 里的 t(' 会被误吃）
  for (const match of clientSource.matchAll(/(?<![A-Za-z_])t\('([a-zA-Z0-9_.]+)'/gu)) used.add(match[1])
  for (const match of clientSource.matchAll(/t\(`\$\{([^}]+)\}\.[a-z]+`/gu)) used.add(match[1])
  const missing = [...used].filter((key) => !defined.has(key))
  assert.deepEqual(missing, [], `这些键没有中文文案：${missing.join(', ')}`)
})

test('回调在两侧都要在场（防止传了没接：以前 onOpenGraph 就栽在这）', () => {
  // 调用方传参
  assert.ok(/onOpenGraph:\s*openGraph/u.test(clientSource), '调用方应传 onOpenGraph')
  // 接收方解构
  assert.ok(/function StreamPane\(\{[^}]*onOpenGraph/u.test(clientSource), 'StreamPane 应解构 onOpenGraph')
  assert.ok(/function FishboneView\([^)]*\)/u.test(clientSource))
  assert.ok(/onOpenStream:\s*openStream/u.test(clientSource), '调用方应传 onOpenStream')
  assert.ok(/onOpenStream,/u.test(clientSource), 'FishboneView 应解构 onOpenStream')
})
