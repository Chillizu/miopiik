#!/usr/bin/env node
/**
 * 真实模型闭环：在 3080 里开一个临时会话，让模型按 fenced ```iui 输出 AST，
 * 验证客户端解析、校验、渲染与局部降级。独立 headless context，token 不落盘。
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire('/home/chillizu/.dsh/profiles/web/node_modules/')
const { chromium } = require('playwright')
const BASE = 'http://127.0.0.1:3080'

const AST = {
  title: '周活跃概览',
  fallback: '近 7 天活跃 74 次',
  state: { range: { series: [['一', 12], ['二', 18], ['三', 15]], current: 45, prev: 31 } },
  root: {
    id: 'root',
    type: 'column',
    props: { gap: 10 },
    children: [
      { id: 'seg', type: 'segmented', props: { label: '范围', bind: '$state.range', options: [
        { label: '近7天', value: { series: [['一', 12], ['二', 18], ['三', 15]], current: 45, prev: 31 } },
        { label: '近30天', value: { series: [['第1周', 40], ['第2周', 61]], current: 101, prev: 88 } },
      ] } },
      { id: 'm1', type: 'metric', props: { label: '当前区间', value: '$state.range.current', unit: '次' } },
      { id: 'm2', type: 'metric', props: { label: '上一区间', value: '$state.range.prev', unit: '次' } },
      { id: 'c', type: 'chart', props: { kind: 'bar', series: '$$state.range.series', source: '示例' } },
      { id: 'bad', type: 'qrcode', props: {} },
    ],
  },
}
// 修正 chart 绑定（上面刻意留了 typo 用于降级验证）
AST.root.children[3].props.series = '$state.range.series'
AST.root.children[3].props.source = '示例'
const PROMPT = [
  '请只输出下面这个 fenced 代码块，语言名必须是 iui，内容必须原样照抄（不要改写、不要解释、不要调用工具）：',
  '```iui',
  JSON.stringify(AST, null, 2),
  '```',
].join('\n')

function loginUrl() {
  const log = execFileSync('journalctl', ['--user', '-u', 'dsh-web', '-o', 'cat'], { encoding: 'utf8' })
  const matches = [...log.matchAll(/http:\/\/127\.0\.0\.1:3080\/\?token=([A-Za-z0-9_-]+)/gu)]
  if (matches.length === 0) throw new Error('没有可用登录 token')
  return `${BASE}/?token=${matches[matches.length - 1][1]}`
}

const evidence = { errors: [] }
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu'] })
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript(() => { try { localStorage.setItem('miopiik.inlineBody', '1') } catch {} })
  const page = await context.newPage()
  page.on('pageerror', (error) => evidence.errors.push(String(error).slice(0, 200)))
  page.on('console', (m) => { if (m.type() === 'error' && !/404/u.test(m.text())) evidence.errors.push('console: ' + m.text().slice(0, 160)) })
  await page.goto(loginUrl(), { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  evidence.diag = {
    path: await page.evaluate(() => location.pathname),
    hasComposer: await page.locator('textarea, [contenteditable="true"]').count(),
    body: (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 160),
  }
  await page.screenshot({ path: '.dsh/e2e/iui-model-state.png' })
  if (evidence.diag.hasComposer === 0) {
    console.log(JSON.stringify({ ok: false, blocked: 'no-composer', evidence }, null, 2))
    await context.close()
    process.exit(0)
  }
  // 安全边界：只允许在**新建的空会话**里发测试消息。找不到"新会话"就中止，
  // 绝不回落到用户已有会话（曾经误把测试提示词排进主会话的待发送队列）。
  const fresh = page.getByRole('button', { name: /新建会话|新会话/ }).first()
  if ((await fresh.count()) === 0) {
    console.log(JSON.stringify({ ok: false, blocked: 'no-new-session-button', evidence }, null, 2))
    await context.close()
    process.exit(0)
  }
  await fresh.click()
  await page.waitForTimeout(2200)
  const emptyComposer = await page.evaluate(() => {
    const el = document.querySelector('textarea, [contenteditable="true"]')
    const value = el?.value ?? el?.innerText ?? ''
    return value.trim() === ''
  })
  evidence.startedNewEmptySession = emptyComposer
  if (!emptyComposer) {
    console.log(JSON.stringify({ ok: false, blocked: 'composer-not-empty', evidence }, null, 2))
    await context.close()
    process.exit(0)
  }
  await page.locator('textarea, [contenteditable="true"]').first().waitFor({ timeout: 5000 }).catch(() => {})
  const input = page.locator('textarea, [contenteditable="true"]').first()
  await input.click()
  await page.keyboard.insertText(PROMPT)
  await page.waitForTimeout(400)
  const sendButton = page.locator('button[aria-label]').filter({ hasText: '' })
  const send = page.getByRole('button', { name: /发送|Send/i }).first()
  if (await send.count()) await send.click()
  else await page.keyboard.press('Enter')

  const output = page.locator('[data-iui-output]').first()
  let rendered = false
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(2000)
    if (await output.count()) { rendered = true; break }
  }
  evidence.defaultOffInChat = false
  evidence.rendered = rendered
  if (rendered) {
    evidence.metrics = await page.locator('[data-iui-metric]').evaluateAll((nodes) => nodes.map((n) => n.textContent.replace(/\s+/g, ' ').trim()))
    evidence.chart = (await page.locator('[data-iui-chart]').count()) > 0
    const switchBtn = page.getByRole('button', { name: '近30天', exact: true }).first()
    if (await switchBtn.count()) {
      await switchBtn.click()
      await page.waitForTimeout(500)
      evidence.metricsAfterSwitch = await page.locator('[data-iui-metric]').evaluateAll((nodes) => nodes.map((n) => n.textContent.replace(/\s+/g, ' ').trim()))
    }
    evidence.degradedNodeVisible = (await page.locator('[data-iui-output]').first().innerText()).includes('无法渲染')
  }
  evidence.bodyHasLiteralFence = (await page.locator('body').innerText()).includes('```iui')
  await page.screenshot({ path: '.dsh/e2e/iui-model.png' })
  await context.close()
} finally {
  await browser.close()
}
const ok = evidence.rendered === true && evidence.errors.length === 0
console.log(JSON.stringify({ ok, evidence }, null, 2))
process.exitCode = ok ? 0 : 1
