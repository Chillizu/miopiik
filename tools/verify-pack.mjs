#!/usr/bin/env node
/**
 * 打包产物验证（CI / 发布前使用）。
 *
 *   node tools/verify-pack.mjs
 *
 * 做的是"用户真正会装到的东西"的端到端检查：
 *   1. `npm pack` 出真实 tarball，记录文件名与 SHA256
 *   2. 解包，逐文件 `node --check`
 *   3. 校验 exports 目标、README/LICENSE/图标、禁止清单（test/docs/.github 等）
 *   4. 在干净临时目录里 `npm install <tarball>`，再 `import` 包名，确认可加载
 *   5. 输出 JSON 摘要；任一失败退出码 1
 *
 * 只使用 Node 内置能力，不需要网络（本地 tarball 安装、零运行时依赖）。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(root, '.dsh', 'tmp', 'verify-pack')
const cache = join(root, '.dsh', 'tmp', 'npm-cache')
rmSync(work, { recursive: true, force: true })
mkdirSync(join(work, 'packs'), { recursive: true })
mkdirSync(cache, { recursive: true })

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const problems = []
const fail = (message) => problems.push(message)

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

// 1. 真实打包
const packOutput = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', join(work, 'packs'), '--cache', cache, '--no-audit', '--no-fund']))
const entry = Array.isArray(packOutput) ? packOutput[0] : (packOutput[packOutput.name] ?? Object.values(packOutput)[0])
const tarball = join(work, 'packs', entry.filename)
if (!existsSync(tarball)) fail(`npm pack 未产出 tarball：${tarball}`)
const sha256 = existsSync(tarball) ? createHash('sha256').update(readFileSync(tarball)).digest('hex') : null

// 2. 解包
const unpacked = join(work, 'unpacked')
mkdirSync(unpacked, { recursive: true })
run('tar', ['-xzf', tarball, '-C', unpacked])
const pkgRoot = join(unpacked, 'package')
const packedFiles = entry.files.map((file) => file.path).sort()

const jsFiles = []
const walk = (dir) => {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, item.name)
    if (item.isDirectory()) walk(full)
    else if (/\.(?:m?js)$/u.test(item.name)) jsFiles.push(full)
  }
}
walk(pkgRoot)
for (const file of jsFiles) {
  try {
    run(process.execPath, ['--check', file])
  } catch (error) {
    fail(`node --check 失败：${relative(pkgRoot, file)}：${String(error.stderr ?? error.message).slice(0, 200)}`)
  }
}

// 3. 结构检查
for (const field of ['name', 'version', 'main', 'exports', 'files']) {
  if (manifest[field] === undefined) fail(`package.json 缺少 ${field}`)
}
for (const [key, target] of Object.entries(manifest.exports ?? {})) {
  if (typeof target !== 'string') continue
  if (!target.startsWith('./')) {
    fail(`exports["${key}"] 必须是相对路径：${target}`)
    continue
  }
  if (target.includes('*')) {
    // 通配符导出（如 "./locale/*.json"）：在打包清单里至少匹配到一个真实文件
    const pattern = new RegExp(
      '^' + target.slice(2).replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '[^/]*') + '$',
      'u',
    )
    if (!packedFiles.some((file) => pattern.test(file))) fail(`exports["${key}"] 的通配符在 tarball 内没有匹配文件：${target}`)
    continue
  }
  if (!existsSync(join(pkgRoot, target))) fail(`exports["${key}"] 指向的文件不在 tarball 内：${target}`)
}
if (!existsSync(join(pkgRoot, 'README.md'))) fail('tarball 缺少 README.md')
if (!existsSync(join(pkgRoot, 'LICENSE'))) fail('tarball 缺少 LICENSE')
if (manifest.exports?.['./icon'] !== undefined && !existsSync(join(pkgRoot, manifest.exports['./icon']))) fail('tarball 缺少图标文件')
for (const forbidden of ['test/', 'docs/', '.github/', 'node_modules/']) {
  if (packedFiles.some((file) => file.startsWith(forbidden))) fail(`tarball 不应包含 ${forbidden}`)
}
for (const file of packedFiles) {
  if (file.includes('node_modules')) fail(`tarball 含 node_modules：${file}`)
}

// 4. 干净目录安装 + import 冒烟
const installDir = join(work, 'install')
mkdirSync(installDir, { recursive: true })
writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: 'verify-pack-sandbox', private: true, type: 'module' }, null, 2))
try {
  // 用仓库内可写 cache，避免污染/依赖用户级只读 cache（沙箱与 CI 都更稳）
  run('npm', ['install', '--cache', cache, '--no-audit', '--no-fund', '--ignore-scripts', tarball], { cwd: installDir })
} catch (error) {
  fail(`npm install <tarball> 失败：${String(error.stderr ?? error.message).slice(0, 300)}`)
}
const imported = join(installDir, 'node_modules', manifest.name, manifest.main ?? 'index.js')
if (!existsSync(imported)) {
  fail(`安装后找不到入口：${manifest.name}/${manifest.main ?? 'index.js'}`)
} else {
  try {
    const module = await import(pathToFileURL(imported).href)
    const exported = Object.keys(module)
    if (exported.length === 0) fail('入口模块没有任何导出')
  } catch (error) {
    fail(`安装后 import 入口失败：${String(error.message).slice(0, 300)}`)
  }
}

const report = {
  ok: problems.length === 0,
  package: {
    name: manifest.name,
    version: manifest.version,
    tarball: entry.filename,
    sha256,
    packedBytes: entry.size,
    unpackedBytes: entry.unpackedSize,
    files: packedFiles,
    syntaxChecked: jsFiles.length,
    installImport: problems.length === 0 ? 'ok' : 'failed',
    problems,
  },
}
console.log(JSON.stringify(report, null, 2))
process.exitCode = report.ok ? 0 : 1
