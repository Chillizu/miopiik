import test from 'node:test'
import assert from 'node:assert/strict'

import { parseBackstageCommand } from '../miopiik-dsh/host/commands.js'

test('干预命令：划掉开环 / 标废事实', () => {
  assert.deepEqual(parseBackstageCommand('loop close L-1'), { kind: 'loop', op: 'close', id: 'L-1' })
  assert.deepEqual(parseBackstageCommand('  loop drop   L-2 '), { kind: 'loop', op: 'drop', id: 'L-2' })
  assert.deepEqual(parseBackstageCommand('fact invalidate F-1'), { kind: 'fact', op: 'invalidate', id: 'F-1' })
})

test('干预命令：缺 id 与未知命令都给出可读错误，而不是静默', () => {
  assert.match(parseBackstageCommand('loop close').error, /缺少开环 id/)
  assert.match(parseBackstageCommand('fact invalidate').error, /缺少事实卡 id/)
  assert.match(parseBackstageCommand('').error, /用法/)
  assert.match(parseBackstageCommand('delete everything').error, /未知命令/)
})
