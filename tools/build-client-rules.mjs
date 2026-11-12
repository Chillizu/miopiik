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
const blocksPath = join(root, 'miopiik-dsh', 'shared', 'assistant-blocks.js')
const dslPath = join(root, 'miopiik-dsh', 'shared', 'ui-dsl.js')
const clientPath = join(root, 'miopiik-dsh', 'client.js')

export const BEGIN = '    // >>> miopiik:spec-rules (generated; edit miopiik-dsh/shared/spec-rules.js)'
export const END = '    // <<< miopiik:spec-rules'

export function buildBlocksBlock() {
  const source = readFileSync(blocksPath, 'utf8')
  const body = source.replace(/^export\s+(const|function|let)\s/gmu, '$1 ').trim()
  return [
    '    // >>> miopiik:assistant-blocks (generated; edit miopiik-dsh/shared/assistant-blocks.js)',
    '    const ASSISTANT_BLOCKS = (() => {',
    body.replace(/^/gmu, '      '),
    '      return { ASSISTANT_BLOCK_KINDS, planAssistantBlocks }',
    '    })()',
    '    // <<< miopiik:assistant-blocks',
  ].join('\n')
}

export function buildDslBlock() {
  const source = readFileSync(dslPath, 'utf8')
  const body = source.replace(/^export\s+(const|function|let)\s/gmu, '$1 ').trim()
  return [
    '    // >>> miopiik:ui-dsl (generated; edit miopiik-dsh/shared/ui-dsl.js)',
    '    const UI_DSL = (() => {',
    body.replace(/^/gmu, '      '),
    '      return { compileInlineDsl, comparePayloadCost }',
    '    })()',
    '    // <<< miopiik:ui-dsl',
  ].join('\n')
}

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
  const pairs = [
    [BEGIN, END, buildBlock()],
    ['    // >>> miopiik:assistant-blocks (generated; edit miopiik-dsh/shared/assistant-blocks.js)', '    // <<< miopiik:assistant-blocks', buildBlocksBlock()],
    ['    // >>> miopiik:ui-dsl (generated; edit miopiik-dsh/shared/ui-dsl.js)', '    // <<< miopiik:ui-dsl', buildDslBlock()],
  ]
  for (const [begin, end, expected] of pairs) {
    const start = client.indexOf(begin)
    const stop = client.indexOf(end)
    if (start < 0 || stop < 0) return { ok: false, reason: 'client.js 里找不到 markers' }
    if (client.slice(start, stop + end.length) !== expected) return { ok: false, current: client.slice(start, stop + end.length), expected }
  }
  return { ok: true }
}

export function writeBlock() {
  const client = readFileSync(clientPath, 'utf8')
  const pairs = [
    [BEGIN, END, buildBlock()],
    ['    // >>> miopiik:assistant-blocks (generated; edit miopiik-dsh/shared/assistant-blocks.js)', '    // <<< miopiik:assistant-blocks', buildBlocksBlock()],
    ['    // >>> miopiik:ui-dsl (generated; edit miopiik-dsh/shared/ui-dsl.js)', '    // <<< miopiik:ui-dsl', buildDslBlock()],
  ]
  let next = client
  for (const [begin, end, block] of pairs) {
    const start = next.indexOf(begin)
    const stop = next.indexOf(end)
    if (start < 0 || stop < 0) throw new Error('client.js 里找不到 markers')
    next = next.slice(0, start) + block + next.slice(stop + end.length)
  }
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
