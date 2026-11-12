import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = join(root, '.dsh', 'tmp', 'fork-generator-test')
const patch = join(root, '.dsh', 'tmp', 'fork-generator-test.patch')

function run(args = []) {
  return execFileSync(process.execPath, ['tools/fork-chat-embeds.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, MIOPIIK_FORK_DIR: tmp, MIOPIIK_FORK_PATCH: patch },
  })
}

test('生成器：重建 fork 后必须恢复 node_modules 依赖链接（曾因 rmSync 丢失导致插件 import 失败）', () => {
  rmSync(tmp, { recursive: true, force: true })
  rmSync(patch, { force: true })
  const first = JSON.parse(run())
  assert.equal(first.dependencies.present, true)
  assert.match(first.dependencies.resolved['@deepseek-ai/schemastery'], /schemastery/u)
  assert.equal(lstatSync(join(tmp, 'node_modules')).isSymbolicLink(), true)

  // 第二次重建：链接必须仍然存在且可解析
  const second = JSON.parse(run())
  assert.equal(second.dependencies.present, true)
  assert.match(second.dependencies.resolved['@deepseek-ai/schemastery'], /schemastery/u)

  // 上游解析必须来自 DSH 安装，不能解析到本仓库（否则会自我复制）
  assert.ok(!first.upstreamDir.startsWith(root + '/'), `上游不应来自仓库：${first.upstreamDir}`)
})

test('生成器 --check 只读：不删除 fork、不删除依赖链接', () => {
  const before = lstatSync(join(tmp, 'node_modules'))
  const out = run(['--check'])
  assert.match(out, /一致/u)
  const after = lstatSync(join(tmp, 'node_modules'))
  assert.equal(existsSync(join(tmp, 'node_modules')), true)
  assert.equal(after.ino, before.ino, '--check 不应重建链接（inode 应保持不变）')
  const client = readFileSync(join(tmp, 'lib', 'client.js'), 'utf8')
  assert.match(client, /__miopiikMarkdownEmbeds/u)
  assert.match(client, /miopiik\.markdownEmbeds"\) !== "1"\) return null/u)
  // 补丁产物必须同时写出，供上游评审
  assert.match(readFileSync(patch, 'utf8'), /miopiik:markdown-embeds/u)
})
