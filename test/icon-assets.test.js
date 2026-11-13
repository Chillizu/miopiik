import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_ICON_BYTES = 256 * 1024
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const iconPath = resolve(root, manifest.exports?.['./icon'] ?? 'icon.svg')

/**
 * 用户设计原稿是仓库外的设计资产，不随包分发。
 * 本机默认在用户 Downloads 下找同一个文件名；其他环境用 MIOPIIK_ICON_ORIGINAL 覆盖。
 * 找不到就跳过逐字节比对（保留结构检查），干净 clone / CI 不因此失败。
 */
const envOriginal = process.env.MIOPIIK_ICON_ORIGINAL
const originalPath = envOriginal ?? join(homedir(), 'Downloads', 'DSH Plugin icons', 'Organized', 'MiOpIIk.svg')

test('图标结构：单包单图标，满足 DSH 官方 icon 约束', () => {
  const bytes = readFileSync(iconPath)
  assert.ok(bytes.length <= MAX_ICON_BYTES, `图标超过 256KiB（${bytes.length} 字节）`)
  const text = bytes.toString('utf8')
  assert.match(text.trimStart(), /^<svg[\s>]/u, '图标必须是 SVG 文本')
  assert.match(text, /viewBox="0 0 36 36"/u, '画布尺寸应与设计稿一致（0 0 36 36）')
  assert.doesNotMatch(text, /<script\b|on[a-z]+\s*=|javascript:/iu, '图标里不允许脚本或事件属性')
  assert.doesNotMatch(text, /(?:xlink:)?href\s*=\s*"(?!#|data:)/iu, '图标不允许外部引用')
  // 渐变与遮罩是设计的一部分，不能被简化掉
  assert.match(text, /linearGradient|radialGradient/u, '丢失渐变定义')
  assert.match(text, /mask=|clip-path=/u, '丢失遮罩/裁剪')
  assert.equal(statSync(iconPath).isFile(), true)
})

test('包资产：package.json 的 ./icon 导出与 files 清单都指向根 icon.svg', () => {
  assert.equal(manifest.exports?.['./icon'], './icon.svg', '缺少 "./icon" 导出')
  assert.equal(iconPath, join(root, 'icon.svg'), './icon 应指向包根 icon.svg')
  assert.ok((manifest.files ?? []).includes('icon.svg'), 'files 打包清单未包含 icon.svg')
})

test('图标静态检查：tools/icon-check.mjs 通过（发布与 CI 的同一份判据）', () => {
  const output = execFileSync(process.execPath, ['tools/icon-check.mjs'], { cwd: root, encoding: 'utf8', timeout: 120000 })
  const report = JSON.parse(output)
  assert.equal(report.ok, true, JSON.stringify(report.icon.problems))
  assert.equal(report.icon.viewBox, '0 0 36 36')
  assert.equal(report.icon.path, 'icon.svg')
  assert.ok(report.original.provided === false || report.original.identical === true)
})

test('设计原稿逐字节一致（原稿不在本机时跳过比对）', (t) => {
  if (!existsSync(originalPath)) {
    if (envOriginal !== undefined) assert.fail(`MIOPIIK_ICON_ORIGINAL 指向的文件不存在：${originalPath}`)
    t.skip(`用户设计原稿不在本机（${originalPath}），跳过逐字节比对；结构检查已单独执行`)
    return
  }
  const shipped = readFileSync(iconPath)
  const original = readFileSync(originalPath)
  assert.equal(shipped.equals(original), true, '仓库内 icon.svg 与用户设计原稿不一致（设计资产不允许重绘）')

  const output = execFileSync(process.execPath, ['tools/icon-check.mjs', '--original', originalPath], { cwd: root, encoding: 'utf8', timeout: 120000 })
  const report = JSON.parse(output)
  assert.equal(report.ok, true, JSON.stringify(report.icon.problems))
  assert.equal(report.original.provided, true)
  assert.equal(report.original.identical, true)
})
