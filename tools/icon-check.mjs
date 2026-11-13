#!/usr/bin/env node
/**
 * 插件图标资产检查（DSH 官方 icon 规范核对；可选与用户设计原稿逐字节比对）。
 *
 *   node tools/icon-check.mjs
 *   node tools/icon-check.mjs --original "/path/to/Organized/Icon.svg"
 *
 * 检查项：
 *  1. 官方限制：SVG、≤256KiB、不得含脚本/事件/外部引用
 *  2. 包内资产：package.json 的 ./icon 导出与 files 清单指向真实文件
 *  3. 尺寸：viewBox 存在且为 36×36（与设计稿一致），渐变/遮罩不得被简化
 *  4. 可选：与用户原稿逐字节一致（原稿不随仓库分发，故默认只做结构检查）
 *
 * 输出 JSON；任一问题退出码为 1。用户原稿是设计资产，本工具只读，绝不改写。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_ICON_BYTES = 256 * 1024
const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const shipped = resolve(root, manifest.exports?.['./icon'] ?? 'icon.svg')
const original = option('original') ?? process.env.MIOPIIK_ICON_ORIGINAL

const problems = []
if (!existsSync(shipped)) {
  console.error(`图标不存在：${shipped}`)
  process.exit(1)
}
const bytes = readFileSync(shipped)
const text = bytes.toString('utf8')

if (bytes.length > MAX_ICON_BYTES) problems.push(`${shipped}: 超过 256KiB`)
if (!/^<svg[\s>]/u.test(text.trimStart())) problems.push(`${shipped}: 不是以 <svg> 开头的 SVG`)
if (!/\bviewBox="0 0 36 36"/u.test(text)) problems.push(`${shipped}: viewBox 不是 0 0 36 36（设计稿尺寸）`)
if (/<script\b|on[a-z]+\s*=|javascript:/iu.test(text)) problems.push(`${shipped}: 含脚本或事件属性`)
if (/(?:xlink:)?href\s*=\s*"(?!#|data:)/iu.test(text)) problems.push(`${shipped}: 含外部引用（不允许）`)
if (!/linearGradient|radialGradient/u.test(text)) problems.push(`${shipped}: 丢失渐变定义`)
if (!/mask=|clip-path=/u.test(text)) problems.push(`${shipped}: 丢失遮罩/裁剪`)

if (manifest.exports?.['./icon'] === undefined) problems.push('package.json: 缺少 "./icon" 导出')
else if (resolve(root, manifest.exports['./icon']) !== shipped) problems.push('package.json: "./icon" 指向与预期不一致')
if (!(manifest.files ?? []).some((entry) => entry === 'icon.svg' || entry === './icon.svg')) problems.push('package.json: files 未包含 icon.svg')
if (!existsSync(join(root, 'icon.svg')) && shipped !== join(root, 'icon.svg')) problems.push('包根缺少 icon.svg')

let originalCheck = { provided: false }
if (original !== undefined) {
  if (!existsSync(original)) problems.push(`原稿不存在：${original}`)
  else {
    const originalBytes = readFileSync(original)
    originalCheck = { provided: true, path: original, identical: bytes.equals(originalBytes), originalBytes: originalBytes.length }
    if (!originalCheck.identical) problems.push(`${shipped}: 与用户原稿不是逐字节一致（设计资产不允许重绘）`)
  }
}

const report = {
  ok: problems.length === 0,
  icon: {
    path: shipped.replace(root + '/', ''),
    bytes: bytes.length,
    viewBox: /viewBox="([^"]+)"/u.exec(text)?.[1] ?? null,
    gradients: (text.match(/linearGradient|radialGradient/gu) ?? []).length,
    masks: (text.match(/mask=|clip-path=/gu) ?? []).length,
    problems,
  },
  original: originalCheck,
}
console.log(JSON.stringify(report, null, 2))
process.exitCode = report.ok ? 0 : 1
