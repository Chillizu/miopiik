#!/usr/bin/env node
/**
 * MiOpIIk Agent + independent IUI: native DSH Plugins configuration smoke test.
 * Isolated Playwright browser; never sends a model message or edits user history.
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire('/home/chillizu/.dsh/profiles/web/node_modules/')
const { chromium } = require('playwright')

const BASE = 'http://127.0.0.1:3080'
const outcome = { ok: false, checks: [], errors: [] }
const check = (truth, message) => { if (!truth) outcome.errors.push(message) }
function authUrl() {
  const log = execFileSync('journalctl', ['--user','-u','dsh-web.service','--since','9 hours ago','-o','cat','--no-pager'], {encoding:'utf8'})
  const m = [...log.matchAll(/http:\/\/127\.0\.0\.1:3080\/\?token=([A-Za-z0-9_-]+)/gu)].at(-1)
  if (!m) throw new Error('No authorized local DSH web session')
  return BASE + '/?token=' + m[1]
}
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox','--disable-gpu'] })
try {
  for (const width of [1280, 420]) {
    const context = await browser.newContext({ viewport: { width, height: 950 } })
    const page = await context.newPage()
    const jsErrors = []
    page.on('pageerror', (error) => jsErrors.push(String(error).slice(0, 180)))
    await page.goto(authUrl(), { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: '插件', exact: true }).waitFor({ timeout: 16000 })
    await page.getByRole('button', { name: '插件', exact: true }).click()
    await page.getByRole('button', { name: '查看 MiOpIIk', exact: true }).click()
    const agent = page.locator('[data-miopiik-settings="1"]')
    await agent.waitFor({ state: 'visible', timeout: 10000 })
    const groups = await agent.locator('[data-miopiik-group]').count()
    const ink = agent.locator('[data-miopiik-group="ink"]')
    const inkOpen = (await ink.getAttribute('aria-expanded')) === 'true'
    const defaultCount = await agent.locator('[data-miopiik-default]').count()
    await agent.locator('[data-miopiik-group="mind"]').click()
    const mindVisible = await agent.locator('[data-miopiik-default="conversationCompile"]').count()
    await agent.locator('[data-miopiik-example-toggle]').click()
    const example = await agent.locator('[data-miopiik-config-example]').innerText()
    const agentOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 3)
    outcome.checks.push({ side: 'MiOpIIk Agent', width, groups, inkOpen, defaultCount, mindVisible, exampleOk: example.includes('activeLoopCap: 12'), overflow: agentOverflow })
    check(groups === 3 && inkOpen && defaultCount === 8 && mindVisible === 1, 'Agent group/default mismatch at ' + width)
    check(example.includes('conversationCompile: true') && !agentOverflow, 'Agent config example/overflow failure at ' + width)
    // IUI is a separate installed plugin, not a tab nested inside MiOpIIk.
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: '插件', exact: true }).click()
    await page.getByRole('button', { name: '查看 miopiik-iui', exact: true }).click()
    const iui = page.locator('[data-iui-plugin-settings="1"]')
    await iui.waitFor({ state: 'visible', timeout: 10000 })
    const ready = await iui.locator('[data-iui-registry-state="ready"]').count()
    const preview = await iui.locator('[data-iui-settings-preview="live"]').count()
    await iui.locator('[data-iui-source-toggle]').click()
    const source = await iui.locator('[data-iui-preview-source]').innerText()
    const copy = await iui.locator('[data-iui-copy-source]').count()
    const iuiOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 3)
    const previewMetricBefore = await iui.locator('[data-iui-metric]').allTextContents()
    await iui.getByRole('button', { name: '近 30 天', exact: true }).click()
    const previewMetricAfter = await iui.locator('[data-iui-metric]').allTextContents()
    const changed = previewMetricBefore.join('') !== previewMetricAfter.join('')
    outcome.checks.push({ side: 'IUI', width, ready, preview, sourceOk: source.includes('segmented') && source.includes('iui'), copy, changed, overflow: iuiOverflow })
    check(ready === 1 && preview === 1 && copy === 1 && changed && !iuiOverflow, 'IUI state/preview failure at ' + width)
    check(source.includes('series') && source.includes('state'), 'IUI source example is incomplete at ' + width)
    check(jsErrors.length === 0, 'JS error at ' + width + ': ' + jsErrors.join(';'))
    await context.close()
  }
} finally {
  await browser.close()
}
outcome.ok = outcome.errors.length === 0
console.log(JSON.stringify(outcome, null, 2))
process.exitCode = outcome.ok ? 0 : 1
