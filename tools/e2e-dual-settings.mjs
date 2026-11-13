#!/usr/bin/env node
/**
 * MiOpIIk Agent + independent IUI: native DSH Plugins page smoke test.
 * Isolated Playwright browser; never sends a model message or edits user history.
 *
 * Checks, for light/dark themes and 1280/420 widths:
 *  - each plugin has its own Overview / Configuration page inside the official
 *    plugins.bundle.config slot (no extra slot is invented);
 *  - Agent Configuration is read-only (defaults + YAML example, no switches);
 *  - IUI Configuration has exactly one real browser-local switch, diagnostics
 *    and a copyable example; Overview previews with the real renderer;
 *  - no horizontal overflow, no page errors, native chat still loads.
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire('/home/chillizu/.dsh/profiles/web/node_modules/')
const { chromium } = require('playwright')

const BASE = 'http://127.0.0.1:3080'
const outcome = { ok: false, checks: [], errors: [] }
const check = (truth, message) => { if (!truth) outcome.errors.push(message) }
function authUrl() {
  const log = execFileSync('journalctl', ['--user','-u','dsh-web','-o','cat','--no-pager'], {encoding:'utf8'})
  const m = [...log.matchAll(/http:\/\/127\.0\.0\.1:3080\/\?token=([A-Za-z0-9_-]+)/gu)].at(-1)
  if (!m) throw new Error('No authorized local DSH web session')
  return BASE + '/?token=' + m[1]
}

async function openPlugins(page) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '插件', exact: true }).waitFor({ timeout: 20000 })
  await page.getByRole('button', { name: '插件', exact: true }).click()
}

async function openBundle(page, pkg, { rich = false } = {}) {
  const card = page.locator(`[data-plugin-package="${pkg}"]`)
  await card.waitFor({ state: 'visible', timeout: 20000 })
  await card.locator('button').filter({ hasText: /^MiOpIIk/ }).first().click()
  await page.locator(`[data-plugin-detail="${pkg}"]`).waitFor({ state: 'visible', timeout: 12000 })
  if (rich) {
    await page.locator(pkg === 'miopiik-dsh' ? '[data-miopiik-settings="1"]' : '[data-iui-plugin-settings="1"]')
      .waitFor({ state: 'visible', timeout: 12000 })
  }
}

function pageText() {
  return document.body.innerText.replace(/\s+/g, ' ')
}

const tokens = {}
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox','--disable-gpu'] })
try {
  for (const width of [1280, 420]) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme })
      const page = await context.newPage()
      const jsErrors = []
      page.on('pageerror', (error) => jsErrors.push(String(error).slice(0, 180)))
      const url = authUrl()
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      // The deployment may persist an explicit theme; force only this page's
      // palette attribute so both token sets get exercised without touching settings.
      await page.evaluate((wanted) => {
        const wantDark = wanted === 'dark'
        const isDark = document.body.hasAttribute('data-ds-dark-theme')
        if (wantDark !== isDark) document.body.toggleAttribute('data-ds-dark-theme', wantDark)
      }, theme)
      await page.waitForTimeout(150)
      const token = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim())
      tokens[theme] = token
      check(token !== '', `missing --dsw-alias-bg-base at ${width}/${theme}`)

      // ---- MiOpIIk Agent -------------------------------------------------
      await openPlugins(page)
      await openBundle(page, 'miopiik-dsh', { rich: true })
      const agent = page.locator('[data-miopiik-settings="1"]')
      const agentTabs = await agent.getByRole('tab').allTextContents()
      check(agentTabs.join('|') === '介绍|配置', `Agent tabs wrong at ${width}/${theme}: ${agentTabs.join('|')}`)
      let agentBody = await page.evaluate(pageText)
      check(/Mind/.test(agentBody) && /Ink/.test(agentBody) && /Operator/.test(agentBody), 'Agent overview must describe Mind/Ink/Operator at ' + width)
      check(/v?0\.1\.1/.test(agentBody), 'Agent overview must show its version at ' + width)
      check(/miopiik-iui/.test(agentBody) && /独立插件/.test(agentBody), 'Agent overview must state independence from IUI')
      check(await agent.locator('[data-miopiik-overview]').count() === 1, 'Agent overview missing')
      const agentOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 3)
      check(!agentOverflow, 'Agent overview overflows at ' + width)

      await agent.getByRole('tab', { name: '配置', exact: true }).click()
      await agent.locator('[data-miopiik-configuration="1"]').waitFor({ timeout: 5000 })
      agentBody = await page.evaluate(pageText)
      const defaultCount = await agent.locator('[data-miopiik-default]').count()
      const groupCount = await agent.locator('[data-miopiik-group]').count()
      const example = await agent.locator('[data-miopiik-config-example]').innerText()
      const agentSwitches = await agent.locator('[role="switch"], input').count()
      const agentConfigOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 3)
      check(defaultCount === 14, `Agent config should list 14 defaults, got ${defaultCount}`)
      check(groupCount === 3, `Agent config should group defaults in 3 groups, got ${groupCount}`)
      check(example.includes('- id: miopiik-dsh') && example.includes('config:') && example.includes('activeLoopCap:'), 'Agent YAML example incomplete')
      check(/内置默认值，不是当前实际运行值/.test(agentBody), 'Agent config must state defaults are not current values')
      check(agentSwitches === 0, 'Agent config must not fake switches/inputs')
      check(!agentConfigOverflow, 'Agent config overflows at ' + width)
      outcome.checks.push({ side: 'MiOpIIk Agent', width, theme, tabs: 2, groups: groupCount, defaults: defaultCount, switches: agentSwitches, token })

      // ---- MiOpIIk IUI ---------------------------------------------------
      await openPlugins(page)
      await openBundle(page, 'miopiik-iui', { rich: true })
      const iui = page.locator('[data-iui-plugin-settings="1"]')
      const iuiTabs = await iui.getByRole('tab').allTextContents()
      check(iuiTabs.join('|') === '介绍|配置', `IUI tabs wrong at ${width}/${theme}: ${iuiTabs.join('|')}`)
      const preview = await iui.locator('[data-iui-settings-preview="live"]').count()
      const ready = await iui.locator('[data-iui-registry-state="ready"]').count()
      const chart = await iui.locator('[data-iui-chart]').count()
      const iuiBody = await page.evaluate(pageText)
      check(preview === 1, 'IUI overview preview must be live')
      check(ready >= 1, 'IUI renderer must be connected')
      check(chart > 0, 'IUI preview chart must render')
      check(/兼容性与边界/.test(iuiBody) && /MiOpIIk Agent/.test(iuiBody), 'IUI overview compatibility copy missing')
      check(/声明式 Markdown 界面/.test(iuiBody), 'IUI overview must explain declarative Markdown UI')
      const metricBefore = await iui.locator('[data-iui-metric]').allTextContents()
      await iui.getByRole('button', { name: '近 30 天', exact: true }).click()
      const metricAfter = await iui.locator('[data-iui-metric]').allTextContents()
      check(metricBefore.join('') !== metricAfter.join(''), 'IUI local interaction should update the preview')
      const iuiOverviewOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 3)
      check(!iuiOverviewOverflow, 'IUI overview overflows at ' + width)

      await iui.getByRole('tab', { name: '配置', exact: true }).click()
      await iui.locator('[data-iui-configuration="1"]').waitFor({ timeout: 5000 })
      const switches = await iui.locator('[role="switch"]').count()
      const source = await iui.locator('[data-iui-preview-source]').innerText()
      const copyButtons = await iui.getByRole('button', { name: '复制示例', exact: true }).count()
      const iuiConfigBody = await page.evaluate(pageText)
      const iuiConfigOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 3)
      check(switches === 1, `IUI config must expose exactly one real switch, got ${switches}`)
      check(source.includes('iui') && source.includes('segmented') && source.includes('chart'), 'IUI copyable example incomplete')
      check(copyButtons === 1, 'IUI copy button missing')
      check(/仅作用于当前浏览器/.test(iuiConfigBody), 'IUI switch must be described as browser-local')
      check(/实验性 DSH Chat Markdown 补丁/.test(iuiConfigBody), 'IUI diagnostics must state the experimental integration')
      check(!iuiConfigOverflow, 'IUI config overflows at ' + width)

      // The one real setting: persistence is browser-local and forces a reload
      // so historical messages re-render with the new preference.
      if (width === 1280 && theme === 'light') {
        const prefBefore = await page.evaluate(() => localStorage.getItem('miopiik.markdownEmbeds'))
        await iui.getByRole('switch').click()
        await page.waitForLoadState('domcontentloaded').catch(() => {})
        await page.waitForTimeout(700)
        const prefAfter = await page.evaluate(() => localStorage.getItem('miopiik.markdownEmbeds'))
        check(prefBefore !== '0' && prefAfter === '0', 'IUI real render switch must persist the browser-local preference')
        outcome.checks.push({ side: 'IUI switch', width, theme, before: prefBefore, after: prefAfter })
      }
      outcome.checks.push({ side: 'IUI', width, theme, tabs: 2, preview, ready, chart, switches, copyButtons, token })

      // ---- Native chat still loads --------------------------------------
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
      const composer = page.getByRole('textbox').first()
      await composer.waitFor({ state: 'visible', timeout: 15000 })
      const chatBody = await page.evaluate(() => document.body.innerText)
      check(!/Failed to load|渲染失败/.test(chatBody), 'Native chat shows a load failure')
      outcome.checks.push({ side: 'chat', width, theme, loaded: true })

      check(jsErrors.length === 0, `JS error at ${width}/${theme}: ${jsErrors.join('; ')}`)
      await context.close()
    }
  }
} finally {
  await browser.close()
}
check(tokens.light !== undefined && tokens.dark !== undefined && tokens.light !== tokens.dark, 'light and dark palettes should resolve to different --dsw-alias-bg-base values')
outcome.ok = outcome.errors.length === 0
console.log(JSON.stringify(outcome, null, 2))
process.exitCode = outcome.ok ? 0 : 1
