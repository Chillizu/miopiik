import test from 'node:test'
import assert from 'node:assert/strict'

import { shouldStall } from '../miopiik-dsh/host/operator.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

const MIN = 60 * 1000
const base = { observedSeq: 10, lastSeen: 10, lastProgressAt: 1000, stallMs: 6 * MIN, now: 1000 + 7 * MIN }

test('卡住判定：还在跑、观测没变、超过静默阈值', () => {
  assert.equal(shouldStall({ ...base, job: { state: 'running' } }), true)
})

test('有产出就不算卡住（观测序号变了）', () => {
  assert.equal(shouldStall({ ...base, job: { state: 'running' }, observedSeq: 11 }), false)
})

test('没到阈值不报（避免把慢当成死）', () => {
  assert.equal(shouldStall({ ...base, job: { state: 'running' }, now: 1000 + 2 * MIN }), false)
})

test('任务已结束/超时/不存在都不报', () => {
  for (const state of ['done', 'failed', 'timeout', 'stalled']) {
    assert.equal(shouldStall({ ...base, job: { state } }), false, state)
  }
  assert.equal(shouldStall({ ...base, job: undefined }), false)
})

// ── 结构守卫：派发路径的核心部件曾被一次粗糙替换整块删掉，静默坏了很久 ──
const source = readFileSync(join(here, '..', 'miopiik-dsh', 'host', 'operator.js'), 'utf8')

test('派发路径的守夜与子会话映射不能被误删', () => {
  assert.match(source, /childEngines\.set\(/, '必须登记子会话 → Ink 运行时的映射，否则 ink_report 找不到')
  assert.match(source, /const stallTimer = setInterval\(/, '无进展守夜必须有定时器')
  assert.match(source, /const timer = setTimeout\(/, '超时看门狗必须有定时器')
  assert.match(source, /attachJobToBranch\(/, '任务要挂到分支上')
})

test('收尾里用到的定时器名字必须在本文件内声明（catch 首行就抛过的坑）', () => {
  assert.match(source, /let stallTimer|const stallTimer =/, 'stallTimer 必须声明')
  assert.match(source, /const timer = setTimeout|let timer/, 'timer 必须声明')
})

test('任务板开卡失败不能阻断派发，且归属在中间层模块', () => {
  assert.match(source, /任务板开卡失败（不影响派发）/, '开卡要包在 try/catch 里')
  assert.match(source, /from '\.\/taskboard\.js'/, 'operator 应使用中间层的任务板模块')
})

test('「做了很多事却没有分支承载」要进 L3 可见性，而不是写成规则', () => {
  assert.match(source, /lastWorkload/, '要记录上一轮的工具强度')
  const engineSource = readFileSync(join(here, '..', 'miopiik-dsh', 'host', 'engine.js'), 'utf8')
  assert.match(engineSource, /没有分支承载它——如果这已经是一条要推进的线/, 'L3 要摆出这条事实')
  assert.match(engineSource, /如果只是查一下，忽略这行/, '给 M 留不做判断的自由')
})
