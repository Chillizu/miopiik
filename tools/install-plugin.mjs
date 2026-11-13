#!/usr/bin/env node
/**
 * 把本仓库的 DSH 插件安装到指定 profile。
 *
 *   node tools/install-plugin.mjs --profile <name> [--mode link|tarball]
 *                                 [--execute] [--allow-running-profile]
 *
 * 默认 dry-run（只打印将执行的命令）。--execute 才会真正打包并安装。
 * 为保护正在使用的 profile，默认拒绝 web profile；确需写入要显式加 --allow-running-profile。
 *
 * 测试钩子：DSH_BIN 可覆盖 `dsh` 可执行文件路径（回归测试用桩验证真正执行）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)

const profile = option('profile', null)
const mode = option('mode', 'link')
const execute = flag('execute')
const allowRunning = flag('allow-running-profile')
const dshBin = process.env.DSH_BIN ?? 'dsh'

if (profile === null) {
  console.error('用法：node tools/install-plugin.mjs --profile <name> [--mode link|tarball] [--execute]')
  process.exit(2)
}
if (profile === 'web' && execute && !allowRunning) {
  console.error('拒绝直接写入正在使用的 web profile：请先备份，确认后加 --allow-running-profile，并重启 DSH 生效。')
  process.exit(2)
}
if (mode !== 'link' && mode !== 'tarball') {
  console.error(`未知 --mode：${mode}（可选 link | tarball）`)
  process.exit(2)
}

const packDir = join(root, '.dsh', 'tmp', 'packs')
const steps = mode === 'link'
  ? [{ kind: 'install', note: `link install ${manifest.name}@${manifest.version}`, command: dshBin, args: ['plugin', '--profile', profile, 'add', root] }]
  : (() => {
      mkdirSync(packDir, { recursive: true })
      const tarball = join(packDir, `${manifest.name}-${manifest.version}.tgz`)
      return [
        { kind: 'pack', note: `pack ${manifest.name}@${manifest.version}`, command: 'npm', args: ['pack', '--pack-destination', packDir, '--cache', join(root, '.dsh', 'tmp', 'npm-cache'), '--no-audit', '--no-fund'], cwd: root, output: tarball },
        { kind: 'install', note: `install ${manifest.name}@${manifest.version} from tarball`, command: dshBin, args: ['plugin', '--profile', profile, 'add', tarball], requires: tarball },
      ]
    })()

for (const step of steps) {
  if (step.args.some((arg) => arg.includes('<') || arg.includes('>'))) {
    console.error(`内部错误：命令里仍有占位符：${[step.command, ...step.args].join(' ')}`)
    process.exit(3)
  }
}

console.log(JSON.stringify({ profile, mode, execute, package: { name: manifest.name, version: manifest.version }, steps: steps.map((step) => ({ note: step.note, command: [step.command, ...step.args].join(' ') })) }, null, 2))

if (!execute) {
  console.log('\n（dry-run）以上命令未执行；加 --execute 才会真正打包/安装。')
  process.exit(0)
}

for (const step of steps) {
  if (step.requires !== undefined && !existsSync(step.requires)) {
    // pack 步骤执行完产物必须存在，否则立刻失败，绝不"看似执行"
    console.error(`打包产物不存在：${step.requires}`)
    process.exit(4)
  }
  console.log(`\n$ ${[step.command, ...step.args].join(' ')}`)
  execFileSync(step.command, step.args, { cwd: step.cwd ?? root, stdio: 'inherit' })
  if (step.output !== undefined && !existsSync(step.output)) {
    console.error(`npm pack 未产出预期文件：${step.output}`)
    process.exit(4)
  }
}
console.log('\n安装命令已完成；重启对应 profile 的 DSH 后生效。')
