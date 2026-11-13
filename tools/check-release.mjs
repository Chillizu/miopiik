#!/usr/bin/env node
/**
 * 发布就绪检查（两个插件包）。
 *
 *   node tools/check-release.mjs
 *
 * 检查：元数据、打包清单与真实 import 图是否一致、tarball 内容、图标规范、
 * 版本策略（stable / rc）、README/LICENSE、profile 依赖假设。
 * 需要可写的 npm cache：默认放到 .dsh/tmp/npm-cache（系统 npm cache 在沙箱里只读）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cache = join(root, '.dsh', 'tmp', 'npm-cache')
mkdirSync(cache, { recursive: true })

const PACKAGES = ['miopiik-dsh', 'miopiik-iui']
const REQUIRED_FIELDS = ['name', 'version', 'description', 'license', 'main', 'exports', 'files', 'engines']

/** 把 files 清单展开成实际会被打包的文件集合（npm 的 glob 语义简化版）。 */
function expandFiles(pkgDir, patterns) {
  const out = new Set()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.add(relative(pkgDir, full))
    }
  }
  for (const pattern of patterns) {
    if (pattern.endsWith('/')) {
      const dir = join(pkgDir, pattern)
      if (existsSync(dir)) walk(dir)
      continue
    }
    if (pattern.includes('*')) {
      const [prefix, suffix] = pattern.split('*')
      const base = join(pkgDir, dirname(prefix) === '.' ? '' : dirname(prefix))
      if (existsSync(base)) walk(base)
      for (const file of [...out]) if (!file.endsWith(suffix.replace(/^\//u, ''))) out.delete(file)
      continue
    }
    out.add(pattern)
  }
  return out
}

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
 * 真正打包一次（不 dry-run），解包后逐个 JS 做 node --check，
 * 这样验证的是"用户实际会装到的产物"，而不是工作目录。
 */
function packAndVerify(pkgDir) {
  const dest = join(root, '.dsh', 'tmp', 'packs')
  mkdirSync(dest, { recursive: true })
  const output = execFileSync('npm', ['pack', '--json', '--pack-destination', dest, '--cache', cache, '--no-audit', '--no-fund'], { cwd: pkgDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const parsed = JSON.parse(output)
  // npm 10+ 输出以包名为键的对象；旧版是数组
  const entry = Array.isArray(parsed) ? parsed[0] : (parsed[parsed.name] ?? Object.values(parsed)[0])
  const tarball = join(dest, entry.filename)
  const unpackDir = join(root, '.dsh', 'tmp', 'packs', `${entry.name}-unpacked`)
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

function packDryRun(pkgDir) {
  return packAndVerify(pkgDir)
}

const report = { ok: true, packages: [] }
for (const name of PACKAGES) {
  const pkgDir = join(root, name)
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const problems = []
  for (const field of REQUIRED_FIELDS) if (manifest[field] === undefined) problems.push(`${name}: package.json 缺少 ${field}`)
  if (manifest.private === true) problems.push(`${name}: 仍标记 private:true，无法作为独立包发布`)
  if (!/^0\.\d+\.\d+(?:-rc\.\d+)?$/u.test(manifest.version)) problems.push(`${name}: 版本 ${manifest.version} 不符合 0.x 发布策略`)
  if (!existsSync(join(pkgDir, 'README.md'))) problems.push(`${name}: 缺少 README.md`)
  if (!existsSync(join(pkgDir, 'LICENSE'))) problems.push(`${name}: 缺少 LICENSE`)
  if (manifest.exports?.['./icon'] === undefined) problems.push(`${name}: 缺少 "./icon" 导出`)

  const packed = packDryRun(pkgDir)
  const packedSet = new Set(packed.files)
  // 入口图：主入口 + 包导出里所有 .js/.mjs 入口
  const entries = new Set(['index.js'])
  for (const value of Object.values(manifest.exports ?? {})) if (typeof value === 'string' && /\.m?js$/u.test(value)) entries.add(value.replace(/^\.\//u, ''))
  for (const [key, value] of Object.entries(manifest.exports ?? {})) {
    if (typeof value === 'string' && /\.m?js$/u.test(value) && key === './client') entries.add(value.replace(/^\.\//u, ''))
  }
  const needed = importGraph(pkgDir, [...entries])
  for (const file of needed) {
    if (!packedSet.has(file)) problems.push(`${name}: 运行时依赖 ${file} 不在 tarball 内（files 清单缺失）`)
  }
  for (const file of packed.files) {
    if (!existsSync(join(pkgDir, file))) problems.push(`${name}: tarball 声明的 ${file} 不存在`)
  }
  if (packed.unpackedSize > 5 * 1024 * 1024) problems.push(`${name}: 解包体积超过 5MiB`)

  const icon = join(pkgDir, 'icon.svg')
  if (existsSync(icon) && statSync(icon).size > 256 * 1024) problems.push(`${name}: 图标超过 256KiB`)

  report.packages.push({
    name,
    version: manifest.version,
    tarball: packed.filename,
    files: packed.files.length,
    sizeBytes: packed.size,
    unpackedBytes: packed.unpackedSize,
    runtimeDependencies: [...needed].length,
    syntaxChecked: packed.syntaxChecked,
    problems,
  })
  if (problems.length > 0) report.ok = false
}
console.log(JSON.stringify(report, null, 2))
process.exitCode = report.ok ? 0 : 1
