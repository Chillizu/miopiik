#!/usr/bin/env node
/** 实机验证：MiOpIIk 视图页里的实验性 IUI 预览（默认关闭）。 */
const port = process.env.CDP_PORT ?? '9222'
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.filter((t) => t.type === 'page').find((t) => t.url.includes('127.0.0.1:3080'))
const socket = new WebSocket(page.webSocketDebuggerUrl)
let id = 1
const pending = new Map()
const errors = []
await new Promise((res, rej) => { socket.addEventListener('open', res); socket.addEventListener('error', rej) })
socket.addEventListener('message', (event) => {
  const m = JSON.parse(event.data)
  if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params?.exceptionDetails?.exception?.description ?? '').slice(0, 160))
  const call = pending.get(m.id)
  if (call === undefined) return
  pending.delete(m.id)
  m.error ? call.rej(new Error(m.error.message)) : call.res(m.result)
})
const send = (method, params = {}) => new Promise((res, rej) => { const callId = id++; pending.set(callId, { res, rej }); socket.send(JSON.stringify({ id: callId, method, params })) })
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await send('Runtime.enable')
await send('Page.reload', { ignoreCache: true })
await sleep(4000)
const clickByText = (text) => evaluate(`(() => {
  const nodes = [...document.querySelectorAll('button, [role="tab"], a, div')];
  const target = nodes.find((n) => n.textContent.trim() === ${JSON.stringify(text)} || n.textContent.trim().startsWith(${JSON.stringify(text)}));
  if (!target) return false; target.click(); return true;
})()`)
await clickByText('MiOpIIk'); await sleep(1200)
await clickByText('视图'); await sleep(1000)
const before = await evaluate(`(() => ({ panel: !!document.querySelector('[data-dsl-preview]'), state: document.querySelector('[data-dsl-preview]')?.getAttribute('data-dsl-preview') }))()`)
await clickByText('关'); await sleep(600)
const afterOn = await evaluate(`(() => document.querySelector('[data-dsl-preview]')?.getAttribute('data-dsl-preview'))()`)
await clickByText('示例：图表 + 说明'); await sleep(800)
const chartCase = await evaluate(`(() => { const out = document.querySelector('[data-dsl-output]'); return { cards: out?.querySelectorAll('[role="group"]').length ?? 0, text: (out?.innerText ?? '').slice(0, 80) } })()`)
await clickByText('示例：坏样例'); await sleep(800)
const brokenCase = await evaluate(`(() => { const out = document.querySelector('[data-dsl-output]'); return { cards: out?.querySelectorAll('[role="group"]').length ?? 0, text: (out?.innerText ?? '').slice(0, 120) } })()`)
console.log(JSON.stringify({ before, afterOn, chartCase, brokenCase, errors }, null, 2))
socket.close()
