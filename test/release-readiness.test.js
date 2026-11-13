import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

function read(file) {
  return readFileSync(join(root, file), 'utf8')
}

function runChecker() {
  const output = execFileSync(process.execPath, ['tools/check-release.mjs'], { cwd: root, encoding: 'utf8', timeout: 180000 })
  return JSON.parse(output)
}

test('发布检查：单包可以独立打包，且 tarball 覆盖全部运行时依赖', () => {
  const report = runChecker()
  assert.equal(report.ok, true, JSON.stringify(report.package.problems))
  assert.equal(report.package.name, 'miopiik-dsh', '本仓库只发布 miopiik-dsh 一个包')
  assert.equal(report.package.version, manifest.version)
  // 打包阻塞回归：host/ 必须在包里（曾经从 tarball 安装时 import './host/engine.js' 失败）
  assert.ok(report.package.files >= 25, `tarball 文件数异常（${report.package.files}），host/ 可能又漏了`)
  assert.ok(report.package.runtimeDependencies >= 15, '运行时 import 图覆盖不足')
  assert.ok(report.package.syntaxChecked >= 15, '解包后的语法检查覆盖不足')
  // 体积约束（防止把 upstream fork / node_modules 打进包）
  assert.ok(report.package.unpackedBytes < 2 * 1024 * 1024, '解包体积异常')
  assert.equal(report.package.tarball.startsWith('miopiik-iui'), false, '不应打包出 IUI 包')
})

test('版本策略：0.1.1 稳定版，可发布且不依赖 IUI', () => {
  assert.equal(manifest.version, '0.1.1')
  assert.match(manifest.version, /^0\.\d+\.\d+$/u, 'Agent 应为稳定版本号（不带 -rc）')
  assert.equal(manifest.private, undefined, '不应标记 private')
  assert.equal(manifest.name, 'miopiik-dsh')
  // 单包：不得声明对 IUI 的运行时依赖
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = manifest[section] ?? {}
    assert.equal(Object.keys(deps).some((name) => name.includes('miopiik-iui')), false, `${section} 不应依赖 miopiik-iui`)
  }
})

test('发布文档：RELEASE-NOTES 与 SUPPORT-MATRIX 写明 0.1.1 / DSH 0.2.1-rc.5 / 无宿主补丁依赖', () => {
  const notes = read('docs/RELEASE-NOTES.md')
  assert.match(notes, /miopiik-dsh 0\.1\.1/u, 'RELEASE-NOTES 需写明 miopiik-dsh 0.1.1')
  assert.match(notes, /DSH 0\.2\.1-rc\.5/u, 'RELEASE-NOTES 需写明 DSH 测试基线')
  assert.match(notes, /不依赖\s*`?miopiik-iui`?/u, 'RELEASE-NOTES 需写明不依赖 IUI')
  assert.doesNotMatch(notes, /##\s*miopiik-iui /u, '本仓库 release notes 不应包含 IUI 版本段落')

  const matrix = read('docs/SUPPORT-MATRIX.md')
  assert.ok(matrix.includes('miopiik-dsh'), 'SUPPORT-MATRIX 需覆盖 Agent 包')
  assert.match(matrix, /0\.1\.1/u, 'SUPPORT-MATRIX 需写明当前版本')
  assert.match(matrix, /0\.2\.1-rc\.5/u, 'SUPPORT-MATRIX 需写明 DSH 测试基线')
  assert.match(matrix, /无宿主补丁依赖|宿主补丁依赖[^\n]*无/u, 'SUPPORT-MATRIX 需写明无宿主补丁依赖')
  assert.doesNotMatch(matrix, /\|\s*miopiik-iui\s*\(/u, 'SUPPORT-MATRIX 应为 Agent 单列版，不含 IUI 列')
})

test('包资产齐全，安装脚本默认 dry-run 且拒绝未确认写入运行中的 web profile', () => {
  for (const file of ['README.md', 'LICENSE', 'icon.svg', 'cordis.patch.yml', 'index.js', 'client.js']) {
    assert.equal(existsSync(join(root, file)), true, `${file} 缺失`)
  }
  // 干净 clone 里不允许出现旧 monorepo 前缀路径
  const patch = read('cordis.patch.yml')
  assert.doesNotMatch(patch, /miopiik-dsh\/|miopiik-iui\//u, 'cordis.patch.yml 不应含旧 monorepo 前缀路径')

  const dry = execFileSync(process.execPath, ['tools/install-plugin.mjs', '--profile', 'cold-test'], { cwd: root, encoding: 'utf8' })
  assert.match(dry, /dry-run/u, '默认必须是 dry-run')
  assert.match(dry, /plugin --profile cold-test add/u)
  assert.throws(
    () => execFileSync(process.execPath, ['tools/install-plugin.mjs', '--profile', 'web', '--execute'], { cwd: root, encoding: 'utf8', stdio: 'pipe' }),
    /正在使用的 web profile/u,
    '安装脚本必须拒绝在未确认时写入 web profile',
  )
})

test('安装脚本 tarball 模式 --execute 真的执行：用桩 dsh 验证一次安装、产物真实存在', async () => {
  const { mkdtempSync, writeFileSync, readFileSync: readStub, chmodSync, existsSync: exists } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const stubDir = mkdtempSync(join(tmpdir(), 'miopiik-dsh-stub-'))
  const stubLog = join(stubDir, 'calls.log')
  const stub = join(stubDir, 'dsh')
  writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${stubLog}"\nexit 0\n`, 'utf8')
  chmodSync(stub, 0o755)

  // tarball 模式：先 npm pack 出真实 .tgz，再把这个路径交给 dsh（单包：只应调用一次）
  execFileSync(process.execPath, ['tools/install-plugin.mjs', '--profile', 'cold-test', '--mode', 'tarball', '--execute'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DSH_BIN: stub, PATH: `${stubDir}:${process.env.PATH}` },
    timeout: 180000,
  })
  const calls = readStub(stubLog, 'utf8').trim().split('\n')
  assert.equal(calls.length, 1, `单包只应安装一次，实际：\n${calls.join('\n')}`)
  const expected = join(root, '.dsh', 'tmp', 'packs', `${manifest.name}-${manifest.version}.tgz`)
  assert.equal(calls[0].startsWith('plugin --profile cold-test add '), true, `调用形状不对：${calls[0]}`)
  assert.equal(calls[0].includes(`${manifest.name}-${manifest.version}.tgz`), true, `未传入真实产物：${calls[0]}`)
  assert.equal(exists(expected), true, `打包产物不存在：${expected}`)
  // 命令里不允许再出现未替换的占位符
  assert.equal(calls.some((call) => call.includes('<') || call.includes('>')), false)
})

test('安装脚本 link 模式 --execute 也真的调用 dsh（一次，指向仓库根）', async () => {
  const { mkdtempSync, writeFileSync, readFileSync: readStub, chmodSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const stubDir = mkdtempSync(join(tmpdir(), 'miopiik-link-stub-'))
  const stubLog = join(stubDir, 'calls.log')
  const stub = join(stubDir, 'dsh')
  writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${stubLog}"\nexit 0\n`, 'utf8')
  chmodSync(stub, 0o755)
  execFileSync(process.execPath, ['tools/install-plugin.mjs', '--profile', 'cold-test', '--mode', 'link', '--execute'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DSH_BIN: stub, PATH: `${stubDir}:${process.env.PATH}` },
  })
  const calls = readStub(stubLog, 'utf8').trim().split('\n')
  assert.equal(calls.length, 1, `单包只应安装一次，实际：\n${calls.join('\n')}`)
  assert.equal(calls[0], `plugin --profile cold-test add ${root}`, 'link 模式应把仓库根交给 dsh')
})

test('README 版本与 package.json 一致（README 作者就绪后生效）', () => {
  const readme = read('README.md')
  assert.ok(readme.includes(manifest.version), `README 未写明当前版本 ${manifest.version}`)
  assert.match(readme, /0\.1\.1/u, 'README 需写明 Agent 0.1.1')
})
