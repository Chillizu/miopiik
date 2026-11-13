import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function runChecker() {
  const output = execFileSync(process.execPath, ['tools/check-release.mjs'], { cwd: root, encoding: 'utf8', timeout: 180000 })
  return JSON.parse(output)
}

test('发布检查：两个包都能独立打包，且 tarball 覆盖全部运行时依赖', () => {
  const report = runChecker()
  assert.equal(report.ok, true, JSON.stringify(report.packages.map((pkg) => pkg.problems).flat()))
  const byName = Object.fromEntries(report.packages.map((pkg) => [pkg.name, pkg]))
  // Agent 的打包阻塞修复回归：host/ 与 shared/ 必须在包里
  assert.ok(byName['miopiik-dsh'].files >= 30, 'miopiik-dsh tarball 文件数异常，host/ 或 shared/ 可能又漏了')
  assert.ok(byName['miopiik-dsh'].runtimeDependencies >= 15)
  assert.ok(byName['miopiik-iui'].files >= 15)
  // 体积约束（防止把 upstream fork 或 node_modules 打进包）
  for (const pkg of report.packages) assert.ok(pkg.unpackedBytes < 2 * 1024 * 1024, `${pkg.name} 解包体积异常`)
})

test('版本策略：Agent 可发布，IUI 在 blocker 解除前必须保持 rc', () => {
  const dsh = JSON.parse(readFileSync(join(root, 'miopiik-dsh', 'package.json'), 'utf8'))
  const iui = JSON.parse(readFileSync(join(root, 'miopiik-iui', 'package.json'), 'utf8'))
  assert.match(dsh.version, /^0\.\d+\.\d+$/u, 'Agent 应为稳定版本号')
  assert.equal(dsh.private, undefined, 'Agent 不应标记 private')
  assert.equal(iui.private, undefined, 'IUI 不应标记 private')
  assert.match(iui.version, /^0\.\d+\.\d+-rc\.\d+$/u, 'IUI 必须保持 rc 直到 blocker 解除')

  const notes = readFileSync(join(root, 'docs', 'RELEASE-NOTES.md'), 'utf8')
  assert.match(notes, /miopiik-dsh 0\.1\.1/u)
  assert.match(notes, /miopiik-iui 0\.1\.0-rc\./u)
  assert.match(notes, /blocker/iu)
  const matrix = readFileSync(join(root, 'docs', 'SUPPORT-MATRIX.md'), 'utf8')
  assert.match(matrix, /0\.2\.1-rc\.5/u, '支持矩阵需写明 DSH 测试基线')
  assert.match(matrix, /实验性 chat 包补丁/u)
})

test('每个包都有 README/LICENSE/图标，且安装脚本默认不写运行中的 profile', () => {
  for (const name of ['miopiik-dsh', 'miopiik-iui']) {
    for (const file of ['README.md', 'LICENSE', 'icon.svg', 'cordis.patch.yml', 'index.js', 'client.js']) {
      assert.equal(existsSync(join(root, name, file)), true, `${name}/${file} 缺失`)
    }
  }
  const dry = execFileSync(process.execPath, ['tools/install-plugin.mjs', '--profile', 'cold-test'], { cwd: root, encoding: 'utf8' })
  assert.match(dry, /dry-run/u)
  assert.throws(
    () => execFileSync(process.execPath, ['tools/install-plugin.mjs', '--profile', 'web', '--execute'], { cwd: root, encoding: 'utf8', stdio: 'pipe' }),
    /正在使用的 web profile/u,
    '安装脚本必须拒绝在未确认时写入 web profile',
  )
})

test('IUI 设置页会显式告知宿主补丁是否生效（未打补丁时不静默失效）', () => {
  const settings = readFileSync(join(root, 'miopiik-iui', 'settings.js'), 'utf8')
  assert.match(settings, /__miopiikMarkdownEmbedsHost/u)
  assert.match(settings, /未检测到补丁/u)
  const fork = readFileSync(join(root, 'miopiik-iui', 'tools', 'fork-chat-embeds.mjs'), 'utf8')
  assert.match(fork, /globalThis\.__miopiikMarkdownEmbedsHost = true/u)
})

test('安装脚本 tarball 模式 --execute 真的执行：用桩 dsh 验证实际产物路径被传入', async () => {
  const { mkdtempSync, writeFileSync, readFileSync: read, chmodSync, existsSync: exists } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const stubDir = mkdtempSync(join(tmpdir(), 'miopiik-dsh-stub-'))
  const stubLog = join(stubDir, 'calls.log')
  const stub = join(stubDir, 'dsh')
  writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${stubLog}"\nexit 0\n`, 'utf8')
  chmodSync(stub, 0o755)

  // tarball 模式：会先 npm pack 出真实 .tgz，再把这个路径交给 dsh
  execFileSync(process.execPath, ['tools/install-plugin.mjs', '--profile', 'cold-test', '--package', 'all', '--mode', 'tarball', '--execute'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DSH_BIN: stub, PATH: `${stubDir}:${process.env.PATH}` },
    timeout: 180000,
  })
  const calls = read(stubLog, 'utf8').trim().split('\n')
  assert.equal(calls.length, 2, `期望两次安装，实际：\n${calls.join('\n')}`)
  for (const [index, name] of ['miopiik-dsh', 'miopiik-iui'].entries()) {
    const manifest = JSON.parse(read(join(root, name, 'package.json'), 'utf8'))
    const expected = join(root, '.dsh', 'tmp', 'packs', `${manifest.name}-${manifest.version}.tgz`)
    assert.equal(calls[index].startsWith('plugin --profile cold-test add '), true)
    assert.equal(calls[index].includes(`${manifest.name}-${manifest.version}.tgz`), true)
    assert.equal(exists(expected), true, `打包产物不存在：${expected}`)
  }
  // 命令里不允许再出现未替换的占位符
  assert.equal(calls.some((call) => call.includes('<') || call.includes('>')), false)
})

test('安装脚本 link 模式 --execute 也真的调用 dsh（而不是仅打印）', async () => {
  const { mkdtempSync, writeFileSync, readFileSync: read, chmodSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const stubDir = mkdtempSync(join(tmpdir(), 'miopiik-link-stub-'))
  const stubLog = join(stubDir, 'calls.log')
  const stub = join(stubDir, 'dsh')
  writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${stubLog}"\nexit 0\n`, 'utf8')
  chmodSync(stub, 0o755)
  execFileSync(process.execPath, ['tools/install-plugin.mjs', '--profile', 'cold-test', '--package', 'dsh', '--mode', 'link', '--execute'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DSH_BIN: stub, PATH: `${stubDir}:${process.env.PATH}` },
  })
  const calls = read(stubLog, 'utf8').trim()
  assert.match(calls, /plugin --profile cold-test add .*miopiik-dsh$/u)
})

test('README 顶部版本与 package.json 一致，且明确标注 prerelease（防止文档漂移）', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'miopiik-iui', 'package.json'), 'utf8'))
  const readme = readFileSync(join(root, 'miopiik-iui', 'README.md'), 'utf8')
  assert.ok(readme.includes(`Version ${manifest.version}`), `README 顶部版本与 package.json（${manifest.version}）不一致`)
  assert.match(readme, /prerelease|预发布/iu, 'rc 版本必须在 README 里明确写为预发布')
  assert.equal(manifest.version.includes('-rc.'), true)
})
