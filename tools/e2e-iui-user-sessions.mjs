#!/usr/bin/env node
/**
 * 两条用户授权的真实 IUI 会话回放验收。
 * 只读导航 + 隔离浏览器本地交互；绝不发送模型消息或改写历史数据。
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire('/home/chillizu/.dsh/profiles/web/node_modules/')
const { chromium } = require('playwright')
const log = execFileSync('journalctl', ['--user', '-u', 'dsh-web.service', '--since', '5 hours ago', '-o', 'cat', '--no-pager'], { encoding: 'utf8' })
const token = [...log.matchAll(/http:\/\/127\.0\.0\.1:3080\/\?token=([A-Za-z0-9_-]+)/gu)].pop()?.[1]
if (!token) throw new Error('无法从当前授权的本地服务日志取得登录入口')
const sessions = [
  'session-183d701c-cf95-42c1-a8c7-7671b2384a91',
  'session-fd1e1e33-7c9b-4179-ad09-fcde4070cbd7',
]
const output = { errors: [], sessions: [] }
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })

try {
  const context = await browser.newContext({ viewport: { width: 1300, height: 900 } })
  await context.addInitScript(() => {
    try {
      localStorage.setItem('miopiik.markdownEmbeds', '1')
      localStorage.setItem('miopiik.inlineBody', '0')
    } catch {}
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => output.errors.push(String(error).slice(0, 180)))
  await page.goto('http://127.0.0.1:3080/?token=' + token, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.goto('http://127.0.0.1:3080/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1400)

  for (const id of sessions) {
    const row = page.locator('[data-row-key="session:' + id + '"]')
    for (let attempt = 0; attempt < 6 && (await row.count()) === 0; attempt += 1) {
      const expand = page.getByRole('button', { name: /展开其余.*个会话/u }).first()
      if ((await expand.count()) === 0) break
      await expand.click()
      await page.waitForTimeout(280)
    }
    if ((await row.count()) !== 1) {
      output.sessions.push({ id, error: '会话不在可见列表中' })
      continue
    }
    await row.click()
    await page.waitForTimeout(1800)
    const check = await page.evaluate(() => {
      const sheets = [...document.querySelectorAll('[data-iui-output]')]
      const wraps = [...document.querySelectorAll('[data-miopiik-block-wrap]')]
      const chartNodes = [...document.querySelectorAll('[data-iui-chart]')]
      const metrics = [...document.querySelectorAll('[data-iui-metric]')]
      const sizes = wraps.map((node) => {
        const parent = node.parentElement
        return { width: Math.round(node.getBoundingClientRect().width), parent: Math.round(parent?.getBoundingClientRect().width ?? 0) }
      })
      const texts = metrics.map((node) => node.textContent.replace(/\s+/gu, ' ').trim())
      return {
        iui: sheets.length,
        degraded: sheets.map((node) => Number(node.getAttribute('data-iui-degraded') ?? -1)),
        invalid: sheets.filter((node) => node.getAttribute('data-iui-output') !== 'ok').length,
        charts: chartNodes.length,
        emptyCharts: document.querySelectorAll('[data-iui-chart-empty]').length,
        badges: document.querySelectorAll('[data-iui-badge]').length,
        metrics: texts,
        hasLiteralUnitBinding: texts.some((text) => text.includes('$state.')),
        wrappers: sizes,
        hasThink: document.querySelectorAll('[data-variant=think]').length > 0,
      }
    })
    const widthOk = check.wrappers.length >= 3 &&
      check.wrappers.every((s) => s.parent > 0 && s.width >= s.parent * 0.9)
    const ok = check.iui >= 3 &&
      check.invalid === 0 &&
      check.degraded.every((x) => x === 0) &&
      check.charts >= 1 &&
      check.emptyCharts === 0 &&
      check.hasLiteralUnitBinding === false &&
      widthOk
    output.sessions.push({ id, ok, ...check, widthOk })
  }
  await context.close()
} finally {
  await browser.close()
}
output.ok = output.errors.length === 0 && output.sessions.length === sessions.length && output.sessions.every((s) => s.ok === true)
console.log(JSON.stringify(output, null, 2))
process.exitCode = output.ok ? 0 : 1
