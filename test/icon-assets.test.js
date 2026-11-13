import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DOWNLOADS = '/home/chillizu/Downloads/DSH Plugin icons'
const PACKAGES = [
  { name: 'miopiik-dsh', icon: join(root, 'miopiik-dsh', 'icon.svg'), organized: join(DOWNLOADS, 'Organized', 'MiOpIIk.svg') },
  { name: 'miopiik-iui', icon: join(root, 'miopiik-iui', 'icon.svg'), organized: join(DOWNLOADS, 'Organized', 'IUI.svg') },
]
const MAX_ICON_BYTES = 256 * 1024

test('图标资产：与用户整理稿逐字节一致，满足 DSH 官方 icon 约束', () => {
  for (const pkg of PACKAGES) {
    const bytes = readFileSync(pkg.icon)
    assert.equal(bytes.equals(readFileSync(pkg.organized)), true, `${pkg.name}: 与 Organized 原稿不一致（不允许重绘）`)
    assert.ok(bytes.length <= MAX_ICON_BYTES, `${pkg.name}: 超过 256KiB`)
    const text = bytes.toString('utf8')
    assert.match(text, /^<svg[\s>]/u)
    assert.match(text, /viewBox="0 0 36 36"/u, `${pkg.name}: 画布尺寸应与设计稿一致`)
    assert.doesNotMatch(text, /<script\b|on[a-z]+\s*=/iu, `${pkg.name}: 图标里不允许脚本/事件`)
    assert.doesNotMatch(text, /(?:xlink:)?href\s*=\s*"(?!#|data:)/iu, `${pkg.name}: 不允许外部引用`)
    // 渐变与遮罩是设计的一部分，不能被简化掉
    assert.match(text, /linearGradient/u, `${pkg.name}: 丢失渐变`)
    assert.match(text, /mask=|clip-path=/u, `${pkg.name}: 丢失遮罩/裁剪`)
  }
})

test('包资产：两个插件都通过 ./icon 导出图标，且 files 打包清单包含它', () => {
  for (const pkg of PACKAGES) {
    const manifest = JSON.parse(readFileSync(join(root, pkg.name, 'package.json'), 'utf8'))
    assert.equal(manifest.exports?.['./icon'], './icon.svg', `${pkg.name}: 缺少 "./icon" 导出`)
    const target = resolve(root, pkg.name, manifest.exports['./icon'])
    assert.equal(statSync(target).isFile(), true)
    assert.equal(target, pkg.icon)
    assert.ok((manifest.files ?? []).includes('icon.svg'), `${pkg.name}: files 未包含 icon.svg`)
  }
})

test('渲染一致性：原稿与整理稿在 36/128/512 下逐像素相同（含渐变与遮罩）', () => {
  const output = execFileSync(process.execPath, ['tools/icon-check.mjs'], { cwd: root, encoding: 'utf8', timeout: 120000 })
  const report = JSON.parse(output)
  assert.equal(report.ok, true, JSON.stringify(report.icons.filter((icon) => icon.problems.length)))
  for (const item of report.rendering) {
    assert.equal(item.identical, true, `${item.name}: 渲染不一致`)
    for (const size of item.diff) assert.equal(size.changedPixels, 0, `${item.name}@${size.size}: ${size.changedPixels} 个像素不同`)
  }
})
