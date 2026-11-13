#!/usr/bin/env node
/**
 * 把一个或两个 MiOpIIk 插件安装到指定 DSH profile。
 *
 *   node tools/install-plugin.mjs --profile <name> [--package dsh|iui|all] [--mode link|tarball]
 *                                 [--execute] [--allow-running-profile]
 *
 * 默认只打印将要执行的命令（dry-run）。真正写入需要 --execute。
 * 为保护正在使用的 profile，默认拒绝 web profile；确实要装请显式加 --allow-running-profile，
 * 并自行在 profile 备份后重启 DSH。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)

const profile = option('profile', null)
const target = option('package', 'all')
const mode = option('mode', 'link')
const execute = flag('execute')
const allowRunning = flag('allow-running-profile')

if (profile === null) {
  console.error('用法：node tools/install-plugin.mjs --profile <name> [--package dsh|iui|all] [--mode link|tarball] [--execute]')
  process.exit(2)
}
if (profile === 'web' && execute && !allowRunning) {
  console.error('拒绝直接写入正在使用的 web profile：请先备份，确认后加 --allow-running-profile，并重启 DSH 生效。')
  process.exit(2)
}

const PACKAGES = target === 'all' ? ['miopiik-dsh', 'miopiik-iui'] : [target === 'dsh' ? 'miopiik-dsh' : 'miopiik-iui']
const steps = []
for (const name of PACKAGES) {
  const dir = join(root, name)
  if (mode === 'link') {
    steps.push({ cwd: root, command: 'dsh', args: ['plugin', '--profile', profile, 'add', dir], note: `link install ${name}` })
  } else {
    const packDir = join(root, '.dsh', 'tmp', 'packs')
    mkdirSync(packDir, { recursive: true })
    steps.push({ cwd: dir, command: 'npm', args: ['pack', '--pack-destination', packDir], note: `pack ${name}` })
    steps.push({ cwd: root, command: 'dsh', args: ['plugin', '--profile', profile, 'add', join(packDir, `${name}-<version>.tgz`)], note: `install ${name} from tarball` })
  }
}

console.log(JSON.stringify({ profile, mode, execute, steps: steps.map((step) => ({ note: step.note, command: [step.command, ...step.args].join(' ') })) }, null, 2))
for (const step of steps) {
  if (!execute) continue
  if (step.args.some((arg) => arg.includes('<version>'))) {
    console.log(`跳过需要补全文件名的一步：${step.args.join(' ')}`)
    continue
  }
  execFileSync(step.command, step.args, { cwd: step.cwd, stdio: 'inherit' })
}
if (!execute) console.log('\n（dry-run）加 --execute 才会真正写入 profile。')
