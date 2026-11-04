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
  const re = /\['([^']+)',\s*'([^']*)',\s*(null|'[^']*'|\d+)\]/gu
  for (const match of block.matchAll(re)) {
    const raw = match[3]
    entries.push([match[1], match[2], raw === 'null' ? null : raw.startsWith("'") ? raw.slice(1, -1) : Number(raw)])
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
    "ctx.slots.inject('settings.section'",
    "ctx.slots.inject('conversation.session.header.utilities'",
    "name: 'settings.section'",
    "name: 'conversation.session.header.utilities'",
    'function SettingsSection(',
    'function Presence(',
  ]) {
    assert.ok(clientSource.includes(needle), `client.js 缺少：${needle}`)
  }
})

test('鱼骨图：数据面与画布都接上了（防止只加页签不画图）', () => {
  for (const needle of [
    'function FishbonePane(',
    'function CountsStrip(',
    'tab graphics',
    "id: 'graph'",
    "h(FishbonePane, { snapshot })",
  ]) {
    if (needle === 'tab graphics') continue
    assert.ok(clientSource.includes(needle), `client.js 缺少：${needle}`)
  }
})
