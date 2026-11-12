#!/usr/bin/env node
/**
 * 把 shared/spec-rules.js 内联进 client.js（浏览器侧不能 import 宿主模块）。
 *
 *   node tools/build-client-rules.mjs          # 写入
 *   node tools/build-client-rules.mjs --check  # 只检查是否与真源一致（漂移即退出码 1）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sharedPath = join(root, 'miopiik-dsh', 'shared', 'spec-rules.js')
const clientPath = join(root, 'miopiik-dsh', 'client.js')

export const BEGIN = '    // >>> miopiik:spec-rules (generated; edit miopiik-dsh/shared/spec-rules.js)'
export const END = '    // <<< miopiik:spec-rules'

export function buildBlock() {
  const source = readFileSync(sharedPath, 'utf8')
  const body = source
    .replace(/^export\s+(const|function|let)\s/gmu, '$1 ')
    .replace(/^export\s*\{[^}]*\}\s*;?\s*$/gmu, '')
    .trim()
  return [
    BEGIN,
    '    const SPEC_RULES = (() => {',
    body.replace(/^/gmu, '      '),
    '      return { UI_PROTOCOL, WIDGET_KINDS, WIDGET_PRESETS, ACTION_KINDS, MEDIA_KINDS, CHART_KINDS, LAYOUT_DIRECTIONS, LIMITS, MEDIA_PATH_PATTERN, isAllowedMediaPath, validateSpec, layoutDepth, widgetFallbackText }',
    '    })()',
    END,
  ].join('\n')
}

export function syncCheck() {
  const client = readFileSync(clientPath, 'utf8')
  const start = client.indexOf(BEGIN)
  const end = client.indexOf(END)
  if (start < 0 || end < 0) return { ok: false, reason: 'client.js 里找不到 markers' }
  const current = client.slice(start, end + END.length)
  const expected = buildBlock()
  return { ok: current === expected, current, expected }
}

export function writeBlock() {
  const client = readFileSync(clientPath, 'utf8')
  const start = client.indexOf(BEGIN)
  const end = client.indexOf(END)
  if (start < 0 || end < 0) throw new Error('client.js 里找不到 markers')
  const next = client.slice(0, start) + buildBlock() + client.slice(end + END.length)
  writeFileSync(clientPath, next, 'utf8')
  return next.length - client.length
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const result = syncCheck()
    if (!result.ok) {
      console.error('spec-rules 与 client.js 不一致：请运行 node tools/build-client-rules.mjs')
      process.exitCode = 1
    } else {
      console.log('spec-rules 一致')
    }
  } else {
    const delta = writeBlock()
    console.log('client.js 已更新，长度变化', delta)
  }
}
