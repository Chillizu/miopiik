#!/usr/bin/env node
/**
 * MiOpIIk Agent 的客户端不得重新内嵌旧 Widget/IUI 渲染协议。
 *
 * 独立的 miopiik-iui 包是唯一的界面渲染来源；本检查防止 Agent 客户端
 * 意外复活第二套渲染器（历史上曾导致两套协议重复、体积膨胀）。
 *
 *   node tools/build-client-rules.mjs --check
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (name) => readFileSync(join(root, name), 'utf8')

const FORBIDDEN = [
  'miopiik:spec-rules',
  'miopiik:assistant-blocks',
  'miopiik:ui-dsl',
  'miopiik:iui-ast',
  'miopiik:miopiik-ml',
  'miopiik:markdown-segments',
  'globalThis.__miopiikMarkdownEmbeds =',
  'function WidgetCard(',
  'function IuiSheet(',
  'function InlineBodySwitch(',
]

export function syncCheck() {
  const agent = read('client.js')
  const present = FORBIDDEN.filter((marker) => agent.includes(marker))
  if (present.length > 0) return { ok: false, reason: 'MiOpIIk Agent client contains retired UI code: ' + present.join(', ') }
  return { ok: true }
}

const checked = syncCheck()
if (!checked.ok) {
  console.error(checked.reason)
  process.exitCode = 1
} else {
  console.log(checked === undefined ? '' : 'MiOpIIk Agent is free of the retired IUI renderer')
}
