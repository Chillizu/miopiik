import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { INK_TOOL_NAMES } from '../miopiik-dsh/host/engine.js'

const here = dirname(fileURLToPath(import.meta.url))
const toolsSource = readFileSync(join(here, '..', 'miopiik-dsh', 'host', 'tools.js'), 'utf8')

/** 工具面里真实注册的所有 ink_* 名字。 */
function registeredTools() {
  const names = new Set()
  for (const match of toolsSource.matchAll(/name:\s*'(ink_[a-z_]+)'/gu)) names.add(match[1])
  return [...names].sort()
}

/** 只给 Operator 的通道：Mind 被单独 restrict 掉，所以它不在 INK_TOOL_NAMES 里。 */
const OPERATOR_ONLY = ['ink_ask', 'ink_report']

test('除 Operator 专用通道外，注册的每个 ink_* 都在拒绝列表里（子 agent 拿不到）', () => {
  const registered = registeredTools()
  assert.ok(registered.length > 5, '应该能读到工具名')
  const missing = registered
    .filter((name) => !INK_TOOL_NAMES.includes(name))
    .filter((name) => !OPERATOR_ONLY.includes(name))
  assert.deepEqual(missing, [], `这些工具没进 INK_TOOL_NAMES：${missing.join(', ')}`)
})

test('Operator 专用通道绝不进拒绝列表（否则它就没法提问了）', () => {
  for (const name of OPERATOR_ONLY) {
    assert.ok(registeredTools().includes(name), `${name} 应已注册`)
    assert.ok(!INK_TOOL_NAMES.includes(name), `${name} 不该在 INK_TOOL_NAMES 里`)
  }
})

test('拒绝列表里没有未注册的名字（防止拼错后静默无效）', () => {
  const registered = new Set(registeredTools())
  const stale = INK_TOOL_NAMES.filter((name) => !registered.has(name))
  assert.deepEqual(stale, [], `这些名字在列表里但没注册：${stale.join(', ')}`)
})
