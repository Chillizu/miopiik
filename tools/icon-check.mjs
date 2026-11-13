#!/usr/bin/env node
/**
 * 插件图标资产检查（DSH 官方 icon 规范核对 + 原稿/整理稿渲染一致性）。
 *
 *   node tools/icon-check.mjs
 *
 * 检查项：
 *  1. 官方限制：SVG/PNG/JPEG/WebP、≤256KiB、manifest 内相对路径、不得含脚本/外链
 *  2. 包内资产：package.json 的 ./icon 导出与 files 清单指向真实文件
 *  3. 渲染一致性：用户原稿（Downloads 根目录）与整理稿（Organized/）逐像素比较
 *  4. 字体/尺寸：viewBox 存在且为 36×36（与设计稿一致）
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOWNLOADS = '/home/chillizu/Downloads/DSH Plugin icons'
const MAX_ICON_BYTES = 256 * 1024
const PAIRS = [
  { name: 'MiOpIIk', original: join(DOWNLOADS, 'MiOpIIk.svg'), organized: join(DOWNLOADS, 'Organized', 'MiOpIIk.svg'), shipped: join(root, 'miopiik-dsh', 'icon.svg'), pkg: join(root, 'miopiik-dsh') },
  { name: 'IUI', original: join(DOWNLOADS, 'IUI.svg'), organized: join(DOWNLOADS, 'Organized', 'IUI.svg'), shipped: join(root, 'miopiik-iui', 'icon.svg'), pkg: join(root, 'miopiik-iui') },
]

function staticChecks(pair) {
  const problems = []
  const bytes = readFileSync(pair.shipped)
  const text = bytes.toString('utf8')
  if (bytes.length > MAX_ICON_BYTES) problems.push(`${pair.shipped}: 超过 256KiB`)
  if (!/^<svg[\s>]/u.test(text.trimStart())) problems.push(`${pair.shipped}: 不是以 <svg> 开头的 SVG`)
  if (!/\bviewBox="0 0 36 36"/u.test(text)) problems.push(`${pair.shipped}: viewBox 不是 0 0 36 36（设计稿尺寸）`)
  if (/<script\b|on[a-z]+\s*=|javascript:/iu.test(text)) problems.push(`${pair.shipped}: 含脚本或事件属性`)
  if (/(?:xlink:)?href\s*=\s*"(?!#|data:)/iu.test(text)) problems.push(`${pair.shipped}: 含外部引用（不允许）`)
  if (!/linearGradient|radialGradient/u.test(text)) problems.push(`${pair.shipped}: 丢失渐变定义`)
  if (!/mask=|clip-path=/u.test(text)) problems.push(`${pair.shipped}: 丢失遮罩/裁剪`)

  const organized = readFileSync(pair.organized)
  if (!bytes.equals(organized)) problems.push(`${pair.shipped}: 与 Organized 整理稿不是逐字节一致`)

  // 包 manifest：exports["./icon"] 与 files 都必须包含该图标
  const manifest = JSON.parse(readFileSync(join(pair.pkg, 'package.json'), 'utf8'))
  const exported = manifest.exports?.['./icon']
  if (exported === undefined) problems.push(`${pair.pkg}/package.json: 缺少 "./icon" 导出`)
  else {
    const target = resolve(pair.pkg, exported)
    if (target !== pair.shipped) problems.push(`${pair.pkg}: "./icon" 指向 ${exported}，与期望不一致`)
    if (statSync(target).size > MAX_ICON_BYTES) problems.push(`${pair.pkg}: 导出图标超限`)
  }
  if (!(manifest.files ?? []).some((entry) => entry === 'icon.svg' || entry === './icon.svg')) {
    problems.push(`${pair.pkg}/package.json: files 未包含 icon.svg`)
  }
  return { problems, bytes: bytes.length, viewBox: /viewBox="([^"]+)"/u.exec(text)?.[1] ?? null, gradients: (text.match(/linearGradient|radialGradient/gu) ?? []).length, masks: (text.match(/mask=|clip-path=/gu) ?? []).length }
}

const require = createRequire('/home/chillizu/.dsh/profiles/web/node_modules/')
const { chromium } = require('playwright')

async function pixelCompare(pairs) {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu'] })
  try {
    const page = await browser.newPage()
    await page.setContent('<!doctype html><html><body></body></html>')
    const results = []
    for (const pair of pairs) {
      const original = readFileSync(pair.original).toString('base64')
      const organized = readFileSync(pair.organized).toString('base64')
      const diff = await page.evaluate(async ({ a, b, sizes }) => {
        const load = async (b64) => {
          const img = new Image()
          img.src = 'data:image/svg+xml;base64,' + b64
          await img.decode()
          return img
        }
        const [imgA, imgB] = await Promise.all([load(a), load(b)])
        const out = []
        for (const size of sizes) {
          const draw = (img) => {
            const canvas = document.createElement('canvas')
            canvas.width = size
            canvas.height = size
            const ctx = canvas.getContext('2d')
            ctx.clearRect(0, 0, size, size)
            ctx.drawImage(img, 0, 0, size, size)
            return ctx.getImageData(0, 0, size, size).data
          }
          const da = draw(imgA)
          const db = draw(imgB)
          let changed = 0
          let maxDelta = 0
          for (let i = 0; i < da.length; i += 4) {
            const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]), Math.abs(da[i + 3] - db[i + 3]))
            if (d > 0) changed += 1
            if (d > maxDelta) maxDelta = d
          }
          out.push({ size, changedPixels: changed, totalPixels: size * size, maxChannelDelta: maxDelta })
        }
        return out
      }, { a: original, b: organized, sizes: [36, 128, 512] })
      results.push({ name: pair.name, diff })
    }
    return results
  } finally {
    await browser.close()
  }
}

const report = { ok: true, icons: [] }
for (const pair of PAIRS) {
  const stat = staticChecks(pair)
  const entry = { name: pair.name, shipped: pair.shipped.replace(root + '/', ''), ...stat }
  if (stat.problems.length > 0) report.ok = false
  report.icons.push(entry)
}
report.rendering = await pixelCompare(PAIRS)
for (const item of report.rendering) {
  const worst = item.diff.reduce((acc, cur) => (cur.maxChannelDelta > acc.maxChannelDelta ? cur : acc), { maxChannelDelta: 0 })
  item.identical = worst.maxChannelDelta === 0
  if (!item.identical) report.ok = false
}
console.log(JSON.stringify(report, null, 2))
process.exitCode = report.ok ? 0 : 1
