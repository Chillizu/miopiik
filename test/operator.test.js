import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'miopiik-dsh', 'host', 'operator.js'), 'utf8')

test('派发路径的守夜与子会话映射不能被误删（曾被一次粗糙替换整块带走）', () => {
  assert.match(source, /childEngines\.set\(/, '必须登记子会话 → Ink 运行时的映射，否则 ink_report 找不到')
  assert.match(source, /const stallTimer = setInterval\(/, '无进展守夜必须有定时器')
  assert.match(source, /const timer = setTimeout\(/, '超时看门狗必须有定时器')
  assert.match(source, /attachJobToBranch\(/, '任务要挂到分支上')
})

test('收尾里用到的每个符号都在作用域内（catch 首行就抛过的坑）', () => {
  // .then/.catch 的第一行会清定时器；这两个名字必须在本文件内声明。
  assert.match(source, /let stallTimer|const stallTimer =/, 'stallTimer 必须声明')
  assert.match(source, /const timer = setTimeout|let timer/, 'timer 必须声明')
})

test('任务板开卡失败不能阻断派发', () => {
  assert.match(source, /任务板开卡失败（不影响派发）/, '开卡要包在 try/catch 里')
})

test('任务板的归属在中间层模块，不在派发路径里自己拼', () => {
  assert.match(source, /from '\.\/taskboard\.js'/, 'operator 应使用中间层的任务板模块')
})
