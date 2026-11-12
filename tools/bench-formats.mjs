#!/usr/bin/env node
/**
 * 真实模型生成闭环 + 输出 token 计量。
 *
 * 每个格式各跑一个新会话（必须先点击「新会话」并确认输入框为空、无历史消息；
 * 条件不满足就中止，绝不回落到用户已有会话）。跑完从会话日志读 usage.outputTokens。
 *
 *   node tools/bench-formats.mjs [--tasks ml,json]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire('/home/chillizu/.dsh/profiles/web/node_modules/')
const { chromium } = require('playwright')
const BASE = 'http://127.0.0.1:3080'
const SESSION_ROOT = '/home/chillizu/.dsh/sessions/--home-data-Projects-Mio-MiOpIIk--/'

const TASKS = {
  ml: [
    '这是一次纯文本生成测试：不要调用任何工具、不要读取代码库、不要解释，只输出最终答案。',
    '请把下面这组数据用界面声明展示出来，整份声明放在一个 fenced 代码块里，语言名 iui：',
    '- 一段中文说明（一句话）',
    '- 两列指标：请求量 1240 次、成功率 98.2%',
    '- 一个时间范围切换（近7天 / 近30天），绑定本地状态 $state.range，切换时指标和图表跟着变',
    '- 一个柱状图，绑定 $state.range.series',
    '格式提示（这是我们的声明式标记，不是 HTML）：<ui title="" fallback=""><state>{json}</state><column gap="10"><text>..</text><row gap="12"><metric label="" value="" unit=""/></row><segmented label="" bind="$state.range" options=\'[{"label":"近7天","value":{...}}]\'/><chart kind="bar" series="$state.range.series"/></column></ui>',
  ].join('\n'),
  json: [
    '这是一次纯文本生成测试：不要调用任何工具、不要读取代码库、不要解释，只输出最终答案。',
    '请把下面这组数据用界面声明展示出来，整份声明放在一个 fenced 代码块里，语言名 iui：',
    '- 一段中文说明（一句话）',
    '- 两列指标：请求量 1240 次、成功率 98.2%',
    '- 一个时间范围切换（近7天 / 近30天），绑定本地状态 $state.range，切换时指标和图表跟着变',
    '- 一个柱状图，绑定 $state.range.series',
    '格式提示（JSON AST）：{"title":"","fallback":"","state":{...},"root":{"id":"root","type":"column","props":{"gap":10},"children":[...]}}；可用 type：text/metric/row/column/grid/card/table/chart/segmented/divider；绑定写成 "$state.xxx"。',
  ].join('\n'),
}

function loginUrl() {
  const log = execFileSync('journalctl', ['--user', '-u', 'dsh-web', '-o', 'cat'], { encoding: 'utf8' })
  const matches = [...log.matchAll(/http:\/\/127\.0\.0\.1:3080\/\?token=([A-Za-z0-9_-]+)/gu)]
  if (matches.length === 0) throw new Error('没有可用登录 token')
  return `${BASE}/?token=${matches[matches.length - 1][1]}`
}

function snapshotSessions() {
  return new Set(readdirSync(SESSION_ROOT).filter((name) => name.startsWith('session-')))
}

function readUsage(sessionDir) {
  const file = join(SESSION_ROOT, sessionDir, 'session.v4.jsonl.zstd')
  let raw = ''
  try {
    raw = execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  } catch {
    return null
  }
  let outputTokens = 0
  let steps = 0
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === 'assistant/message' && event.data?.usage?.outputTokens !== undefined) {
      outputTokens += event.data.usage.outputTokens
      steps += 1
    }
  }
  return { outputTokens, steps }
}

const wanted = (() => {
  const index = process.argv.indexOf('--tasks')
  return index >= 0 ? process.argv[index + 1].split(',') : ['ml', 'json']
})()

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu'] })
const results = []
try {
  for (const key of wanted) {
    const before = snapshotSessions()
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.addInitScript(() => {
      try {
        localStorage.setItem('miopiik.inlineBody', '1')
      } catch {}
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(String(error).slice(0, 160)))
    await page.goto(loginUrl(), { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)

    const fresh = page.getByRole('button', { name: /新建会话|新会话/ }).first()
    if ((await fresh.count()) === 0) {
      results.push({ key, blocked: 'no-new-session-button' })
      await context.close()
      continue
    }
    await fresh.click()
    await page.waitForTimeout(2500)
    const guard = await page.evaluate(() => {
      const el = document.querySelector('textarea, [contenteditable="true"]')
      const value = (el?.value ?? el?.innerText ?? '').trim()
      const steps = document.querySelectorAll('[data-chat-flow-kind="assistant-step"]').length
      return { empty: value === '', steps }
    })
    if (guard.empty !== true || guard.steps !== 0) {
      results.push({ key, blocked: 'not-a-fresh-session', guard })
      await context.close()
      continue
    }

    const input = page.locator('textarea, [contenteditable="true"]').first()
    await input.click()
    await page.keyboard.insertText(TASKS[key])
    await page.waitForTimeout(300)
    const started = Date.now()
    const send = page.getByRole('button', { name: /发送|Send/i }).first()
    if (await send.count()) await send.click()
    else await page.keyboard.press('Enter')

    const output = page.locator('[data-iui-output]').first()
    let firstVisibleMs = null
    for (let i = 0; i < 120; i += 1) {
      await page.waitForTimeout(250)
      if ((await output.count()) > 0) {
        firstVisibleMs = Date.now() - started
        break
      }
    }
    // 等回合稳定
    let lastLen = -1
    let stable = 0
    for (let i = 0; i < 120; i += 1) {
      await page.waitForTimeout(1000)
      const len = await page.evaluate(() => document.body.innerText.length)
      const running = await page.evaluate(() => /思考中|运行中/.test(document.body.innerText))
      if (len === lastLen && running === false) {
        stable += 1
        if (stable >= 2) break
      } else stable = 0
      lastLen = len
    }
    const rendered = (await output.count()) > 0
    const renderedFacts = rendered
      ? {
          format: await output.getAttribute('data-iui-format'),
          kind: await output.getAttribute('data-iui-output'),
          degraded: await output.getAttribute('data-iui-degraded'),
          metrics: await page.locator('[data-iui-metric]').evaluateAll((nodes) => nodes.map((n) => n.textContent.replace(/\s+/g, ' ').trim())),
          hasChart: (await page.locator('[data-iui-chart]').count()) > 0,
          switchable: (await page.getByRole('button', { name: '近30天', exact: true }).count()) > 0,
        }
      : null
    const literalFence = (await page.locator('body').innerText()).includes('```iui')
    await context.close()

    const after = snapshotSessions()
    const created = [...after].filter((name) => !before.has(name))
    const usage = created.length === 1 ? readUsage(created[0]) : null
    results.push({ key, rendered, renderedFacts, firstVisibleMs, literalFence, usage, sessionCount: created.length, errors })
  }
} finally {
  await browser.close()
}
console.log(JSON.stringify({ results }, null, 2))
