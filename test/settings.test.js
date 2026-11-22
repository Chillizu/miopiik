import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

import { Config, DEFAULTS, ORDINARY_DOCS, VOLATILE_DOCS, VOLATILE_KEYS, readConfig } from '../host/config-defaults.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const clientSource = readFileSync(join(root, 'client.js'), 'utf8')

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** 在已安装的 DSH 宿主里定位 schemastery（本仓库零依赖，不重复安装它）。 */
async function loadSchemastery() {
  const specifiers = ['schemastery', '@deepseek-ai/schemastery']
  for (const spec of specifiers) {
    try {
      return await import(spec)
    } catch {
      // 继续尝试文件路径。
    }
  }
  const files = []
  if (process.env.DSH_SCHEMASTERY) files.push(process.env.DSH_SCHEMASTERY)
  for (const base of [homedir(), '/usr', '/usr/local']) {
    files.push(
      join(base, '.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery/lib/index.mjs'),
      join(base, 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery/lib/index.mjs'),
    )
  }
  for (const file of files) {
    try {
      return await import(pathToFileURL(file).href)
    } catch {
      // 继续尝试下一个候选路径。
    }
  }
  return null
}

const schemastery = await loadSchemastery()
if (schemastery === null) {
  console.warn('[settings] 未找到 schemastery 安装：wire 兼容往返测试将跳过（DSH 宿主内应能找到）。')
}

/** 从 client.js 里抽出 MIO_FIELDS 表（避免多维护一份形状）。 */
function clientFields() {
  const start = clientSource.indexOf('const MIO_FIELDS = [')
  assert.ok(start > 0, 'client 里应存在 MIO_FIELDS')
  const end = clientSource.indexOf('\n    ]', start)
  assert.ok(end > start, 'MIO_FIELDS 表应有结束括号')
  const block = clientSource.slice(start, end)
  const entries = []
  const re = /\['([^']+)',\s*'([^']*)',\s*'(checkbox|text|number)'\]/gu
  for (const match of block.matchAll(re)) entries.push([match[1], match[2], match[3]])
  return entries
}

test('4 个 volatile 字段与 host 默认值一一对应，不漂移', () => {
  for (const [key, , , fallback] of VOLATILE_DOCS) {
    assert.ok(key in DEFAULTS, `volatile ${key} 不在 DEFAULTS 里`)
    assert.deepEqual(fallback, DEFAULTS[key], `${key} 的默认值两边不一致`)
  }
  assert.deepEqual(VOLATILE_DOCS.map(([key]) => key), [...VOLATILE_KEYS])
})

test('每个可调项都有中文说明（volatile 与 ordinary 两张表合起来不漏键）', () => {
  const documented = new Map([...VOLATILE_DOCS, ...ORDINARY_DOCS].map(([key, label]) => [key, label]))
  for (const key of Object.keys(DEFAULTS)) {
    assert.ok(documented.has(key), `${key} 缺说明`)
    assert.ok(documented.get(key).length > 0)
  }
  assert.equal(documented.size, Object.keys(DEFAULTS).length, '说明表里不该有 DEFAULTS 之外的键')
})

test('Config 的 DSH Settings 结构：uid/type/meta/dict/toJSON()', () => {
  assert.equal(typeof Config.uid, 'number')
  assert.equal(Config.type, 'object')
  assert.deepEqual(Config.meta, { default: {} })
  assert.deepEqual(Object.keys(Config.dict), [...VOLATILE_KEYS])
  assert.equal(typeof Config.toJSON, 'function')
  for (const key of VOLATILE_KEYS) {
    assert.equal(Config.dict[key].meta.volatile, true, `${key} 应声明 volatile`)
    assert.deepEqual(Config.dict[key].meta.default, DEFAULTS[key])
  }
})

test('Cordis Standard Schema：validate 把 4 个字段包成 volatile 引用（含写入符号与 get）', () => {
  const result = Config['~standard'].validate({})
  assert.equal(result.issues, undefined)
  assert.equal(Config['~standard'].version, 1)
  assert.equal(Config['~standard'].vendor, 'schemastery')
  const value = result.value
  for (const key of VOLATILE_KEYS) {
    const ref = value[key]
    assert.equal(typeof ref, 'object', `${key} 应被包成引用`)
    assert.equal(VOLATILE_WRITE in ref, true, `${key} 引用应带 cosmokit 写入符号`)
    assert.equal(typeof ref.get, 'function')
    assert.equal(Object.isFrozen(ref), true, `${key} 引用应冻结`)
  }
  assert.deepEqual(value.conversationCompile.get(), DEFAULTS.conversationCompile)
  assert.deepEqual(value.activeLoopCap.get(), DEFAULTS.activeLoopCap)
  assert.deepEqual(value.operatorTimeoutMs.get(), DEFAULTS.operatorTimeoutMs)
  // 显式给值时按值包，未声明键原样透传。
  const full = Config['~standard'].validate({ stateRoot: 'x/y', activeLoopCap: 3 })
  assert.equal(full.value.stateRoot, 'x/y')
  assert.equal(full.value.activeLoopCap.get(), 3)
})

test('volatile 引用可原位写入（DSH loader 热更新路径），readConfig 动态解包', () => {
  const value = Config['~standard'].validate({}).value
  // loader 只做一件事：ref[write](source.get())，插件侧无需重启。
  value.conversationCompile[VOLATILE_WRITE](false)
  value.operatorTimeoutMs[VOLATILE_WRITE](60000)
  assert.equal(value.conversationCompile.get(), false)
  assert.equal(readConfig(value, 'conversationCompile'), false)
  assert.equal(readConfig(value, 'operatorTimeoutMs'), 60000)
  // 普通值与缺键的行为。
  assert.equal(readConfig({ activeLoopCap: 5 }, 'activeLoopCap'), 5)
  assert.equal(readConfig({}, 'operatorModel'), undefined)
  const plain = { conversationCompile: true, operatorModel: null, activeLoopCap: 12, operatorTimeoutMs: 1200000 }
  assert.equal(readConfig(plain, 'conversationCompile'), true, '普通配置对象不该被误伤')
})

test('校验失败按 standard-schema 回报 issues（Host 写入被拒而非静默）', () => {
  const bad = Config['~standard'].validate({ activeLoopCap: 'twelve', conversationCompile: 'yes' })
  assert.ok(Array.isArray(bad.issues) && bad.issues.length >= 1)
  assert.deepEqual(
    bad.issues.map((issue) => issue.path),
    [['conversationCompile'], ['activeLoopCap']],
  )
  const badObject = Config['~standard'].validate([])
  assert.ok(Array.isArray(badObject.issues))
})

test('new Schemastery(Config.toJSON()) 可无损还原 4 个 volatile 字段', { skip: schemastery === null }, () => {
  const Schema = schemastery.default
  const restored = new Schema(Config.toJSON())
  assert.equal(restored.type, 'object')
  assert.deepEqual(Object.keys(restored.dict), [...VOLATILE_KEYS])
  for (const key of VOLATILE_KEYS) {
    const child = restored.dict[key]
    assert.equal(child.type, Config.dict[key].type, `${key} 类型应还原`)
    assert.equal(child.meta.volatile, true, `${key} 的 volatile 标记应还原`)
    assert.deepEqual(child.meta.default, DEFAULTS[key])
  }
  // 还原后的 schema 用 DSH 自带的 cosmokit createVolatile 重新包引用，行为一致。
  const out = restored['~standard'].validate({
    conversationCompile: false,
    operatorModel: 'opencode-go/glm-5.3',
    activeLoopCap: 5,
    operatorTimeoutMs: 300000,
  })
  assert.equal(out.issues, undefined)
  for (const key of VOLATILE_KEYS) {
    assert.equal(VOLATILE_WRITE in out.value[key], true, `${key} 还原后仍是 volatile 引用`)
  }
  assert.equal(out.value.conversationCompile.get(), false)
  assert.equal(out.value.operatorModel.get(), 'opencode-go/glm-5.3')
  assert.equal(out.value.activeLoopCap.get(), 5)
  assert.equal(out.value.operatorTimeoutMs.get(), 300000)
  // 双向往返：还原后的 schema 再序列化仍保持 4 个 volatile 字段。
  const again = new Schema(restored.toJSON())
  assert.deepEqual(Object.keys(again.dict), [...VOLATILE_KEYS])
  assert.equal(again.dict.operatorModel.meta.volatile, true)
})

test('客户端 4 个控件与 host 的 VOLATILE_KEYS 不漂移，控件类型对应', () => {
  const fields = clientFields()
  assert.deepEqual(
    fields.map(([key]) => key),
    [...VOLATILE_KEYS],
    'client 控件键应与 host volatile 字段完全一致',
  )
  const kinds = Object.fromEntries(fields.map(([key, , kind]) => [key, kind]))
  assert.equal(kinds.conversationCompile, 'checkbox')
  assert.equal(kinds.operatorModel, 'text')
  assert.equal(kinds.activeLoopCap, 'number')
  assert.equal(kinds.operatorTimeoutMs, 'number')
  for (const [key, label] of fields) {
    const doc = VOLATILE_DOCS.find((entry) => entry[0] === key)
    assert.ok(doc !== undefined, `${key} 缺 host 说明`)
    assert.equal(label, doc[1], `${key} 的中文说明两边不一致`)
  }
})

test('真正用到的常量来自同一张表（改一处即全站生效）', async () => {
  const loops = await import('../host/loops.js')
  const inbox = await import('../host/inbox.js')
  assert.equal(loops.ACTIVE_LOOP_CAP, DEFAULTS.activeLoopCap)
  assert.equal(loops.DORMANT_AFTER_DAYS, DEFAULTS.dormantAfterDays)
  assert.equal(loops.FOLDED_AFTER_DAYS, DEFAULTS.foldedAfterDays)
  assert.equal(inbox.PREVIEW_CHAR_BUDGET, DEFAULTS.inboxPreviewChars)
})

test('关键客户端注册点都在（防止替换静默失效）', () => {
  for (const needle of [
    "ctx.slots.inject('plugins.bundle.config'",
    "ctx.slots.inject('conversation.view'",
    "name: 'plugins.bundle.config'",
    "key: 'miopiik-dsh'",
    "name: 'conversation.view'",
    'function MioPluginPage(',
    "ctx.inject(['configForms']",
    "configForms?.get?.(MIO_PLUGIN_ENTRY)",
    "form.mutate(ops, snap.revision)",
  ]) {
    assert.ok(clientSource.includes(needle), `client.js 缺少：${needle}`)
  }
  // settings.plugins.tab 占坑已撤：整个 client.js 不应再出现它或旧面板。
  assert.ok(!clientSource.includes('settings.plugins.tab'), 'settings.plugins.tab 应已撤除')
  assert.ok(!clientSource.includes('function MioSettingsPanel('), 'MioSettingsPanel 应并入 MioPluginPage')
  // plugins.bundle.config 一个 slot 同时承载介绍与配置。
  assert.ok(clientSource.includes("'data-miopiik-overview'"), '插件页应有介绍区块标记')
  assert.ok(clientSource.includes("'data-miopiik-configuration'"), '插件页应有配置区块标记')
  // 只读死表格与 patch 示例复制块必须彻底消失。
  for (const banned of [
    'data-miopiik-default',
    'data-miopiik-config-example',
    'data-miopiik-copy-status',
    'data-miopiik-architecture',
    'data-miopiik-group',
    'MIO_EXAMPLE',
    'MIO_LAYERS',
    'MIO_FACTS',
    'MIO_GROUPS',
    'MIO_PLUGIN_VERSION',
    'cordis.patch.yml',
  ]) {
    assert.ok(!clientSource.includes(banned), `client.js 不应再出现：${banned}`)
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
  // 2026-11-22 契约裁决：鱼骨头部要一行紧凑形状图例（graph.legendFork/…/graph.noLinks，SVG 内图形+短语）。
  // 这条守卫只继续拦旧形态——graph.legend 单键长文段落（「读法同 git graph：…」那种解释性大段文字）。
  assert.ok(!clientSource.includes("'graph.legend':"), '旧的长文图例（graph.legend 单键段落）不该回来')
  assert.ok(!clientSource.includes('conversation.session.header.utilities'), '入口已合并，不该再占顶栏')
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
