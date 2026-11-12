#!/usr/bin/env node
/**
 * 真实画廊会话的历史回放验收：不发送任何消息，只读回放 + 本地交互。
 * 前提：fork（markdownEmbeds）已启用；否则跳过并说明。
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire('/home/chillizu/.dsh/profiles/web/node_modules/')
const { chromium } = require('playwright')

const log = execFileSync('journalctl', ['--user', '-u', 'dsh-web', '-o', 'cat'], { encoding: 'utf8' })
const token = [...log.matchAll(/http:\/\/127\.0\.0\.1:3080\/\?token=([A-Za-z0-9_-]+)/gu)].pop()?.[1]
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
const out = { errors: [] }
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('miopiik.markdownEmbeds', '1')
      localStorage.setItem('miopiik.inlineBody', '0')
    } catch {}
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => out.errors.push(String(e).slice(0, 160)))
  await page.goto(`http://127.0.0.1:3080/?token=${token}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await page.goto('http://127.0.0.1:3080/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  const item = page.locator('[role="treeitem"]').filter({ hasText: '请在这个独立会话中' }).first()
  if ((await item.count()) === 0) {
    out.blocked = 'gallery-session-not-found'
  } else {
    await item.click()
    await page.waitForTimeout(4000)
    const before = await page.evaluate(() => ({
      iui: document.querySelectorAll('[data-iui-output]').length,
      tables: document.querySelectorAll('[data-iui-table]').length,
      badges: document.querySelectorAll('[data-iui-badge]').length,
      metrics: [...document.querySelectorAll('[data-iui-metric]')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
      degradedTexts: [...document.querySelectorAll('*')].filter((n) => n.children.length === 0 && /无法渲染/.test(n.textContent ?? '')).length,
      assistantSteps: document.querySelectorAll('[data-chat-flow-kind="assistant-step"]').length,
      reasoningRows: document.querySelectorAll('[data-variant="think"]').length,
    }))
    // 第三展区的本地切换：点「近 30 天」，指标应立即变化且不新增消息
    const switchButton = page.getByRole('button', { name: '近 30 天', exact: true }).first()
    const hasSwitch = (await switchButton.count()) > 0
    let after = null
    if (hasSwitch) {
      await switchButton.click()
      await page.waitForTimeout(600)
      after = await page.evaluate(() => ({
        metrics: [...document.querySelectorAll('[data-iui-metric]')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
        assistantSteps: document.querySelectorAll('[data-chat-flow-kind="assistant-step"]').length,
      }))
    }
    out.replay = before
    out.interaction = {
      hasSwitch,
      changed: after !== null && JSON.stringify(after.metrics) !== JSON.stringify(before.metrics),
      addedSteps: after === null ? null : after.assistantSteps - before.assistantSteps,
      beforeRange: before.metrics.find((metric) => metric.startsWith('交互渲染总量')) ?? '',
      afterRange: after?.metrics.find((metric) => metric.startsWith('交互渲染总量')) ?? '',
    }

    // 原生 ReasoningRow 必须能实际展开、折叠，不能只验证 DOM 节点存在。
    // 使用受信任的独立浏览器直接触发当前控件；不发送消息、不修改会话。
    const disclosure = page.locator('[data-variant="think"] [role="button"]').first()
    if ((await disclosure.count()) > 0) {
      const original = await disclosure.getAttribute('aria-expanded')
      await disclosure.evaluate((element) => element.click())
      await page.waitForTimeout(100)
      const toggled = await disclosure.getAttribute('aria-expanded')
      await disclosure.evaluate((element) => element.click())
      await page.waitForTimeout(100)
      const restored = await disclosure.getAttribute('aria-expanded')
      out.reasoning = { original, toggled, restored, working: original !== toggled && original === restored }
    } else {
      out.reasoning = { working: false, blocked: 'native-disclosure-not-found' }
    }
  }
  await ctx.close()
} finally {
  await browser.close()
}
// 收尾门禁：渲染成功之外，真实回放、原生思考折叠与本地状态联动缺一不可。
const ok =
  out.blocked === undefined &&
  out.replay?.iui === 3 &&
  (out.replay?.tables ?? 0) >= 1 &&
  (out.replay?.badges ?? 0) >= 5 &&
  (out.replay?.metrics?.length ?? 0) >= 7 &&
  out.replay?.degradedTexts === 0 &&
  (out.replay?.assistantSteps ?? 0) >= 1 &&
  (out.replay?.reasoningRows ?? 0) >= 1 &&
  out.interaction?.hasSwitch === true &&
  out.interaction?.changed === true &&
  out.interaction?.addedSteps === 0 &&
  out.interaction?.beforeRange.includes('12,480') === true &&
  out.interaction?.afterRange.includes('48,296') === true &&
  out.reasoning?.working === true &&
  out.errors.length === 0
console.log(JSON.stringify({ ok, ...out }, null, 2))
process.exitCode = ok ? 0 : 1
