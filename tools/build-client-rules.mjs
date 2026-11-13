#!/usr/bin/env node
/**
 * MiOpIIk Agent's client no longer embeds the old Widget/IUI protocol.
 * The independent miopiik-iui package is now the canonical rendering source.
 * This guard prevents accidental reintroduction of a second client renderer.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (name) => readFileSync(join(root, name), 'utf8')

export function syncCheck() {
  const agent = read('miopiik-dsh/client.js')
  const standalone = read('miopiik-iui/client.js')
  const forbidden = ['miopiik:spec-rules', 'miopiik:assistant-blocks',
    'miopiik:ui-dsl', 'miopiik:iui-ast', 'miopiik:miopiik-ml',
    'miopiik:markdown-segments', 'globalThis.__miopiikMarkdownEmbeds =',
    'function WidgetCard(', 'function IuiSheet(', 'function InlineBodySwitch(']
  const present = forbidden.filter((marker) => agent.includes(marker))
  if (present.length) return { ok: false, reason: 'MiOpIIk Agent contains retired UI code: ' + present.join(', ') }
  if (!standalone.includes('registerIuiSettings(ctx)')) {
    return { ok: false, reason: 'Independent IUI settings are missing from client bundle' }
  }
  return { ok: true }
}

const checked = syncCheck()
if (process.argv.includes('--check')) {
  if (!checked.ok) {
    console.error(checked.reason)
    process.exitCode = 1
  } else console.log('MiOpIIk Agent is free of legacy IUI renderer')
} else {
  if (!checked.ok) {
    console.error(checked.reason)
    process.exitCode = 1
  } else console.log('No generated UI protocols remain in the Agent; build IUI using miopiik-iui/tools/build.mjs')
}
