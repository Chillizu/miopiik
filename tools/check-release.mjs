#!/usr/bin/env node
/**
 * 单包发布就绪检查。
 *
 * 本仓库根目录就是待发布的 DSH 插件包（package.json 与 index.js 同级）。
 *
 *   node tools/check-release.mjs
 *
 * 检查：
 *   - 必需元数据与版本策略（0.x 稳定版或 -rc.N 预览版）
 *   - README / LICENSE / icon 资产与 exports["./icon"]
 *   - 真实执行 `npm pack`，解包后逐文件比对"打包清单 vs 运行时 import 图"
 *   - 解包后的每个 .js/.mjs 通过 `node --check`
 *   - 体积上限，防止把 upstream fork / node_modules 打进包
 *
 * 输出 JSON 报告；任一问题退出码为 1。
 * 需要可写的 npm cache：默认放在 .dsh/tmp/npm-cache（避免污染用户级缓存）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmpDir = join(root, '.dsh', 'tmp')
const cache = join(tmpDir, 'npm-cache')
const packDest = join(tmpDir, 'packs')
mkdirSync(cache, { recursive: true })
mkdirSync(packDest, { recursive: true })

const REQUIRED_FIELDS = ['name', 'version', 'description', 'license', 'main', 'exports', 'files', 'engines']
const MAX_UNPACKED_BYTES = 5 * 1024 * 1024
const MAX_ICON_BYTES = 256 * 1024

/** 从入口出发，沿相对 import/require 走一遍，返回必须随包发布的文件。 */
function importGraph(pkgDir, entries) {
  const needed = new Set()
  const queue = [...entries]
  const seen = new Set()
  while (queue.length > 0) {
    const rel = queue.shift()
    if (seen.has(rel)) continue
    seen.add(rel)
    const abs = join(pkgDir, rel)
    if (!existsSync(abs) || !statSync(abs).isFile()) continue
    needed.add(rel)
    const source = readFileSync(abs, 'utf8')
    const specifiers = [
      ...source.matchAll(/(?:import|export)[^'"]*from\s*['"](\.{1,2}\/[^'"]+)['"]/gu),
      ...source.matchAll(/import\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/gu),
      ...source.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/gu),
    ].map((match) => match[1])
    for (const specifier of specifiers) {
      const target = resolve(dirname(abs), specifier)
      const asFile = existsSync(target) && statSync(target).isFile() ? target : `${target}.js`
      if (existsSync(asFile) && statSync(asFile).isFile()) queue.push(relative(pkgDir, asFile))
      else if (existsSync(target) && statSync(target).isDirectory()) {
        const index = join(target, 'index.js')
        if (existsSync(index)) queue.push(relative(pkgDir, index))
      }
    }
  }
  return needed
}

/**
 * 真正打包一次并解包，验证用户实际会装到的产物，
 * 而不是"工作目录看起来没问题"。
 */
function packAndVerify(pkgDir) {
  const output = execFileSync(
    'npm',
    ['pack', '--json', '--pack-destination', packDest, '--cache', cache, '--no-audit', '--no-fund'],
    { cwd: pkgDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const parsed = JSON.parse(output)
  // npm 10+ 输出以包名为键的对象；旧版是数组
  const entry = Array.isArray(parsed) ? parsed[0] : (parsed[parsed.name] ?? Object.values(parsed)[0])
  const tarball = join(packDest, entry.filename)
  const unpackDir = join(packDest, `${entry.name}-${entry.version}-unpacked`)
  rmSync(unpackDir, { recursive: true, force: true })
  mkdirSync(unpackDir, { recursive: true })
  execFileSync('tar', ['-xzf', tarball, '-C', unpackDir], { stdio: 'pipe' })
  const extractedRoot = join(unpackDir, 'package')
  const jsFiles = []
  const walk = (dir) => {
    for (const entry2 of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry2.name)
      if (entry2.isDirectory()) walk(full)
      else if (/\.(?:m?js)$/u.test(entry2.name)) jsFiles.push(full)
    }
  }
  walk(extractedRoot)
  for (const file of jsFiles) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  return {
    files: entry.files.map((file) => file.path),
    size: entry.size,
    unpackedSize: entry.unpackedSize,
    filename: entry.filename,
    syntaxChecked: jsFiles.length,
    extractedRoot,
  }
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const problems = []
for (const field of REQUIRED_FIELDS) if (manifest[field] === undefined) problems.push(`package.json 缺少 ${field}`)
if (manifest.private === true) problems.push('仍标记 private:true，无法作为独立包发布')
if (!/^0\.\d+\.\d+(?:-rc\.\d+)?$/u.test(manifest.version)) problems.push(`版本 ${manifest.version} 不符合 0.x 发布策略`)
if (!existsSync(join(root, 'README.md'))) problems.push('缺少 README.md')
if (!existsSync(join(root, 'LICENSE'))) problems.push('缺少 LICENSE')
if (manifest.exports?.['./icon'] === undefined) problems.push('缺少 "./icon" 导出')
else {
  const iconPath = resolve(root, manifest.exports['./icon'])
  if (!existsSync(iconPath)) problems.push(`"./icon" 指向不存在的文件：${manifest.exports['./icon']}`)
  else {
    if (statSync(iconPath).size > MAX_ICON_BYTES) problems.push('图标超过 256KiB')
    const text = readFileSync(iconPath, 'utf8')
    if (!/^<svg[\s>]/u.test(text.trimStart())) problems.push('图标不是 SVG 文本')
    if (/<script\b|on[a-z]+\s*=|javascript:/iu.test(text)) problems.push('图标含脚本/事件属性')
    if (/(?:xlink:)?href\s*=\s*"(?!#|data:)/iu.test(text)) problems.push('图标含外部引用')
  }
  if (!(manifest.files ?? []).some((entry) => entry === 'icon.svg' || entry === './icon.svg')) problems.push('files 未包含 icon.svg')
}

const packed = packAndVerify(root)
const packedSet = new Set(packed.files)
const entries = new Set(['index.js'])
for (const value of Object.values(manifest.exports ?? {})) {
  if (typeof value === 'string' && /\.m?js$/u.test(value)) entries.add(value.replace(/^\.\//u, ''))
}
const needed = importGraph(root, [...entries])
for (const file of needed) if (!packedSet.has(file)) problems.push(`运行时依赖 ${file} 不在 tarball 内（files 清单缺失）`)
for (const file of packed.files) if (!existsSync(join(root, file))) problems.push(`tarball 声明的 ${file} 不存在`)
if (packed.unpackedSize > MAX_UNPACKED_BYTES) problems.push(`解包体积超过 ${MAX_UNPACKED_BYTES} 字节`)
// 打包产物不得包含仓库级开发文件
for (const forbidden of ['node_modules/', '.git/', '.github/', 'test/', 'docs/']) {
  if (packed.files.some((file) => file.startsWith(forbidden))) problems.push(`tarball 不应包含 ${forbidden}`)
}

const report = {
  ok: problems.length === 0,
  package: {
    name: manifest.name,
    version: manifest.version,
    tarball: packed.filename,
    files: packed.files.length,
    sizeBytes: packed.size,
    unpackedBytes: packed.unpackedSize,
    runtimeDependencies: [...needed].length,
    syntaxChecked: packed.syntaxChecked,
    problems,
  },
}
console.log(JSON.stringify(report, null, 2))
process.exitCode = report.ok ? 0 : 1
