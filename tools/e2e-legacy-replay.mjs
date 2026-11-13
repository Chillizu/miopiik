#!/usr/bin/env node
/**
 * 历史兼容 E2E：打开一条含旧 ```ink-view 围栏的真实历史会话（只读回放，不发消息），
 * 断言旧七 Widget 数据经只读 adapter 渲染成新 AST，而不是退化成代码块或报错。
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire('/home/chillizu/.dsh/profiles/web/node_modules/')
const { chromium } = require('playwright')

const log = execFileSync('journalctl', ['--user', '-u', 'dsh-web', '-o', 'cat'], { encoding: 'utf8' })
const token = [...log.matchAll(/http:\/\/127\.0\.0\.1:3080\/\?token=([A-Za-z0-9_-]+)/gu)].pop()?.[1]
// 已知含真实 ```ink-view 围栏的历史会话标题（只读回放，绝不发送消息）
const legacyTitles = ['ink-view 折线图 spec 演示', 'ink-view 柱状图 spec 关闭态验证', 'ink_view 端到端冒烟测试', '来测试一下你输出的IUI可以有']
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
  page.on('pageerror', (error) => out.errors.push(String(error).slice(0, 160)))
  await page.goto(`http://127.0.0.1:3080/?token=${token}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await page.goto('http://127.0.0.1:3080/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  const expand = page.getByText(/展开其余/).first()
  if (await expand.count()) {
    await expand.click()
    await page.waitForTimeout(1200)
  }
  let item = page.locator('[role="treeitem"]').first()
  let matchedTitle = null
  for (const title of legacyTitles) {
    const candidate = page.locator('[role="treeitem"]').filter({ hasText: title }).first()
    if ((await candidate.count()) > 0) {
      item = candidate
      matchedTitle = title
      break
    }
  }
  out.matchedTitle = matchedTitle
  if (matchedTitle === null) {
    out.blocked = 'legacy-session-not-found'
  } else {
    await item.click()
    await page.waitForTimeout(4500)
    out.replay = await page.evaluate(() => ({
      iuiOutputs: document.querySelectorAll('[data-iui-output]').length,
      legacyFormats: [...document.querySelectorAll('[data-iui-output]')].map((node) => node.getAttribute('data-iui-format')).filter((value) => value === 'legacy').length,
      charts: document.querySelectorAll('[data-iui-chart]').length,
      tables: document.querySelectorAll('[data-iui-table]').length,
      degradedTexts: [...document.querySelectorAll('*')].filter((n) => n.children.length === 0 && /无法渲染/.test(n.textContent ?? '')).length,
      // 旧内容不应以代码块形式残留（代码块里会出现 widget 关键字）
      codeBlockWithWidget: [...document.querySelectorAll('pre')].some((node) => (node.textContent ?? '').includes('"widget"')),
      assistantSteps: document.querySelectorAll('[data-chat-flow-kind="assistant-step"]').length,
    }))
  }
  await ctx.close()
} finally {
  await browser.close()
}
const ok = out.blocked === undefined && (out.replay?.legacyFormats ?? 0) >= 1 && out.replay?.codeBlockWithWidget === false && out.errors.length === 0
console.log(JSON.stringify({ ok, ...out }, null, 2))
process.exitCode = ok ? 0 : 1
