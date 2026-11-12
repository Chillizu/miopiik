#!/usr/bin/env node
/**
 * 真实 DSH WebUI 端到端冒烟：在专用新会话里让 agent 跑一段固定剧本，
 * 然后从真实 React 宿主里读回 DOM 事实（卡片数量、aria、降级文本、console 错误）。
 *
 * 用法：node tools/e2e-smoke.mjs [--keep]   结果落在 .dsh/e2e/
 * 前置：tools/dsh-open.mjs 已登录（Cookie 在 CDP 浏览器里）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'

const port = process.env.CDP_PORT ?? '9222'
const outDir = '.dsh/e2e'
mkdirSync(outDir, { recursive: true })

const PROMPT = `这是一次端到端冒烟测试，请严格按顺序执行，不要额外发挥：
1) 调用 ink_view(action="show")，spec 用一份**合法**的 dataset 柱状图（带 fallback）；
2) 再调用一次 ink_view，spec 的 graph 里 nodes 写成 [null]（这是非法输入，工具应当报错），把报错第一句原文贴回；
3) 在回复正文里写一个 \`\`\`ink-view 代码块，内容是一份合法的 dataset 折线图 spec，并在代码块前后各写一句 markdown 说明；
4) 再写一个 \`\`\`ink-view 代码块，内容是 {widget:"mermaid"}（非法），然后另起一行写：上面这条应降级为文本。
最后用一句话收尾。不要画其它卡片。`

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.filter((t) => t.type === 'page').find((t) => t.url.includes('127.0.0.1:3080'))
if (page === undefined) throw new Error('没有 DSH 标签页')

const socket = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
const consoleErrors = []
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
    consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 160))
  }
  if (message.method === 'Runtime.exceptionThrown') {
    consoleErrors.push('EXCEPTION ' + String(message.params?.exceptionDetails?.exception?.description ?? '').slice(0, 160))
  }
  const call = pending.get(message.id)
  if (call === undefined) return
  pending.delete(message.id)
  message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result)
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  return result.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: 'http://127.0.0.1:3080/' })
await sleep(2500)

// 1) 新建专用会话
await evaluate(`(() => { const b = [...document.querySelectorAll('button[aria-label]')].find((x) => x.getAttribute('aria-label') === '新建会话'); b?.click(); return !!b })()`)
await sleep(1200)

// 2) 输入并发送
const typed = await evaluate(`(() => {
  const el = document.querySelector('textarea, [contenteditable="true"]');
  if (!el) return 'no-input';
  el.focus();
  document.execCommand('insertText', false, ${JSON.stringify(PROMPT)});
  return el.textContent?.length > 0 ? 'typed' : 'empty';
})()`)
await sleep(600)
const sent = await evaluate(`(() => {
  const b = [...document.querySelectorAll('button[aria-label]')].find((x) => /发送|Send/i.test(x.getAttribute('aria-label') || ''));
  if (b) { b.click(); return 'clicked'; }
  return 'no-send-button';
})()`)

// 3) 等回合结束：助手消息出现且不再显示运行中
let stable = 0
let lastLen = -1
for (let i = 0; i < 90; i += 1) {
  await sleep(2000)
  const len = await evaluate(`document.body.innerText.length`)
  const busy = await evaluate(`/深度求索|思考中|运行中/.test(document.body.innerText)`)
  if (len === lastLen && busy === false) {
    stable += 1
    if (stable >= 2) break
  } else {
    stable = 0
  }
  lastLen = len
}

// 4) 从真实宿主里读回事实
const facts = await evaluate(`(() => {
  const nodes = [...document.querySelectorAll('[data-chat-flow-kind="miopiik-widget"]')];
  const cards = nodes.map((node) => ({
    aria: node.querySelector('[role="group"]')?.getAttribute('aria-label') ?? null,
    text: node.textContent.replace(/\\s+/g, ' ').slice(0, 90),
    hasSvg: !!node.querySelector('svg'),
  }));
  const body = document.body.innerText;
  return {
    widgetNodes: nodes.length,
    cards,
    degraded: /上面这条应降级为文本|此段界面描述不合法|降级/.test(body),
    fallbackSeen: /降级为文本时显示的就是它|（这一段界面描述不合法/.test(body),
    toolErrorEcho: /nodes|节点必须是对象|未知 widget|未知形状|Cannot/.test(body),
    markdownMixed: /代码块前后/.test(body) || /说明/.test(body),
  };
})()`)

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(`${outDir}/smoke.png`, Buffer.from(shot.data, 'base64'))

const report = {
  at: new Date().toISOString(),
  typed,
  sent,
  widgetNodes: facts?.widgetNodes,
  cards: facts?.cards,
  degraded: facts?.degraded,
  toolErrorEcho: facts?.toolErrorEcho,
  markdownMixed: facts?.markdownMixed,
  consoleErrors: consoleErrors.slice(0, 12),
  screenshot: `${outDir}/smoke.png`,
}
writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
socket.close()
