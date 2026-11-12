#!/usr/bin/env node
/**
 * 自给自足的 3080 实机 E2E：独立 headless Chromium（Playwright），不复用用户 profile、
 * 不需要 CDP 调试端口、不留常驻进程。token 只在进程内使用，绝不打印。
 *
 *   node tools/e2e-playwright.mjs
 *
 * 退出码：0 = 全部断言通过；1 = 有失败（打印结构化证据，不含认证信息）。
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire('/home/chillizu/.dsh/profiles/web/node_modules/')
const { chromium } = require('playwright')

const BASE = 'http://127.0.0.1:3080'
const evidence = { steps: [], errors: [] }
const record = (name, value) => evidence.steps.push({ name, ...value })

function loginUrl() {
  // token 只在内存里拼接，不写日志、不进证据
  const log = execFileSync('journalctl', ['--user', '-u', 'dsh-web', '-o', 'cat'], { encoding: 'utf8' })
  const matches = [...log.matchAll(/http:\/\/127\.0\.0\.1:3080\/\?token=([A-Za-z0-9_-]+)/gu)]
  if (matches.length === 0) throw new Error('服务日志里没有可用的一次性登录 token')
  return `${BASE}/?token=${matches[matches.length - 1][1]}`
}

async function openViewPage(context) {
  const page = await context.newPage()
  page.on('pageerror', (error) => evidence.errors.push(String(error).slice(0, 200)))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    // favicon 之类的静态资源 404 与 IUI 无关，忽略
    if (/Failed to load resource.*404/u.test(text)) return
    evidence.errors.push('console: ' + text.slice(0, 200))
  })
  await page.goto(loginUrl(), { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  // 打开一个已有会话（独立 context 没有"上次打开的会话"状态）
  const session = page.locator('[role="treeitem"]').filter({ hasText: 'MiOpIIk 架构' }).first()
  if (await session.count()) {
    await session.click()
    await page.waitForTimeout(3000)
  }
  await page.getByText('MiOpIIk', { exact: true }).last().click()
  await page.waitForTimeout(1500)
  await page.getByText('视图', { exact: true }).last().click()
  await page.waitForTimeout(1200)
  return page
}

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu'] })
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await openViewPage(context)

  const panel = page.locator('[data-dsl-preview]')
  record('defaultState', { state: await panel.getAttribute('data-dsl-preview') })

  if ((await panel.getAttribute('data-dsl-preview')) !== 'on') {
    await panel.getByRole('button', { name: '关', exact: true }).click()
    await page.waitForTimeout(500)
  }
  record('afterToggle', { state: await panel.getAttribute('data-dsl-preview') })

  const output = page.locator('[data-iui-output]')
  // 1) miopiik-ml（模型面向格式）样例：结构 + 局部状态
  await page.getByRole('button', { name: /示例 ML：指标\+趋势\+切换/ }).click()
  await page.waitForTimeout(800)
  record('mlInteractive', {
    format: await output.getAttribute('data-iui-format'),
    kind: await output.getAttribute('data-iui-output'),
    degraded: await output.getAttribute('data-iui-degraded'),
    metrics: await page.locator('[data-iui-metric]').evaluateAll((nodes) => nodes.map((n) => n.textContent.replace(/\s+/g, ' ').trim())),
  })
  // 2) ML 组合样例：网格 + 卡片 + 表格
  await page.getByRole('button', { name: /示例 ML：两列卡片\+表格/ }).click()
  await page.waitForTimeout(800)
  record('mlCompare', {
    cards: await page.locator('[data-iui-container="card"]').count(),
    grid: await page.locator('[data-iui-container="grid"]').count(),
    tableRows: await page.locator('[data-iui-table]').first().getAttribute('data-iui-table'),
  })
  // 3) ML 局部降级：未知标签只影响自身
  await page.getByRole('button', { name: /示例 ML：局部降级/ }).click()
  await page.waitForTimeout(700)
  record('mlPartial', {
    kind: await output.getAttribute('data-iui-output'),
    degraded: await output.getAttribute('data-iui-degraded'),
    metricStillVisible: (await page.locator('[data-iui-metric]').count()) > 0,
    text: (await output.innerText()).replace(/\s+/g, ' ').slice(0, 100),
  })

  await page.getByRole('button', { name: /示例：指标 \+ 趋势 \+ 切换/ }).click()
  await page.waitForTimeout(700)
  const readMetrics = () => page.locator('[data-iui-metric]').evaluateAll((nodes) => nodes.map((n) => n.textContent.replace(/\s+/g, ' ').trim()))
  const before = await readMetrics()
  const beforePressed = await page.locator('[data-iui-output] button[aria-pressed="true"]').allTextContents()
  const assistantStepsBefore = await page.locator('[data-chart-flow-kind="assistant-step"], [data-chat-flow-kind="assistant-step"]').count()
  record('interactiveInitial', {
    kind: await output.getAttribute('data-iui-output'),
    metrics: before,
    pressed: beforePressed,
    hasChart: (await page.locator('[data-iui-chart]').count()) > 0,
  })

  await page.getByRole('button', { name: '近30天', exact: true }).click()
  await page.waitForTimeout(600)
  const after = await readMetrics()
  const afterPressed = await page.locator('[data-iui-output] button[aria-pressed="true"]').allTextContents()
  const assistantStepsAfter = await page.locator('[data-chat-flow-kind="assistant-step"]').count()
  record('interactiveAfterSwitch', {
    metrics: after,
    pressed: afterPressed,
    changed: JSON.stringify(before) !== JSON.stringify(after),
    modelTurnsAdded: assistantStepsAfter - assistantStepsBefore,
  })

  await page.getByRole('button', { name: /示例：两列对比/ }).click()
  await page.waitForTimeout(600)
  record('compare', {
    columns: await page.locator('[data-iui-container="column"]').count(),
    text: (await output.innerText()).replace(/\s+/g, ' ').slice(0, 120),
  })

  await page.getByRole('button', { name: /示例：坏 AST 降级/ }).click()
  await page.waitForTimeout(600)
  record('brokenAst', { kind: await output.getAttribute('data-iui-output'), text: (await output.innerText()).replace(/\s+/g, ' ').slice(0, 120) })

  // 深色 + 窄屏（同一页切 emulation）
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 420, height: 860 })
  await page.getByRole('button', { name: /示例：指标 \+ 趋势 \+ 切换/ }).click()
  await page.waitForTimeout(600)
  record('darkNarrow', {
    dark: await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches),
    width: await page.evaluate(() => window.innerWidth),
    metricCount: await page.locator('[data-iui-metric]').count(),
    overflow: await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2),
  })

  await context.close()
} finally {
  await browser.close()
}

const broken = evidence.steps.find((s) => s.name === 'brokenAst') ?? {}
const partial = evidence.steps.find((s) => s.name === 'mlPartial') ?? {}
const fail = evidence.errors.length > 0 ||
  evidence.steps.find((s) => s.name === 'interactiveAfterSwitch')?.changed !== true ||
  evidence.steps.find((s) => s.name === 'interactiveAfterSwitch')?.modelTurnsAdded !== 0 ||
  // 局部降级后父级仍然渲染（ok），坏节点自己变成文本
  broken.kind !== 'ok' || broken.text?.includes('无法渲染') !== true ||
  partial.metricStillVisible !== true || partial.text?.includes('无法渲染') !== true
console.log(JSON.stringify({ ok: !fail, evidence }, null, 2))
process.exitCode = fail ? 1 : 0
