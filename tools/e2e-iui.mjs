#!/usr/bin/env node
/** 实机验证：MiOpIIk 视图页的可组合 IUI（局部状态 + 降级）。 */
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
  if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params?.exceptionDetails?.exception?.description ?? '').slice(0, 200))
  const call = pending.get(m.id)
  if (call === undefined) return
  pending.delete(m.id)
  m.error ? call.rej(new Error(m.error.message)) : call.res(m.result)
})
const send = (method, params = {}) => new Promise((res, rej) => { const callId = id++; pending.set(callId, { res, rej }); socket.send(JSON.stringify({ id: callId, method, params })) })
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const click = (label) => evaluate(`(() => {
  const nodes = [...document.querySelectorAll('button')];
  const hit = nodes.find((n) => n.textContent.trim() === ${JSON.stringify(label)} || n.textContent.trim().startsWith(${JSON.stringify(label)}));
  if (!hit) return false; hit.click(); return true;
})()`)
await send('Runtime.enable')
await send('Page.reload', { ignoreCache: true })
await sleep(4000)
await click('MiOpIIk'); await sleep(1200)
await click('视图'); await sleep(1000)
if ((await evaluate(`document.querySelector('[data-dsl-preview]')?.getAttribute('data-dsl-preview')`)) !== 'on') { await click('关'); await sleep(500) }
await click('示例：指标 + 趋势 + 切换'); await sleep(900)
const before = await evaluate(`(() => {
  const box = document.querySelector('[data-iui-output]');
  const metrics = [...(box?.querySelectorAll('[data-iui-metric]') ?? [])].map((n) => n.textContent.replace(/\s+/g, ' ').trim());
  return { kind: box?.getAttribute('data-iui-output'), metrics, hasChart: !!box?.querySelector('[data-iui-chart]'), buttons: [...(box?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim()), pressed: [...(box?.querySelectorAll('button') ?? [])].map((b) => b.getAttribute('aria-pressed')) };
})()`)
await click('近30天'); await sleep(600)
const after = await evaluate(`(() => {
  const box = document.querySelector('[data-iui-output]');
  return { metrics: [...(box?.querySelectorAll('[data-iui-metric]') ?? [])].map((n) => n.textContent.replace(/\s+/g, ' ').trim()), pressed: [...(box?.querySelectorAll('button') ?? [])].map((b) => b.getAttribute('aria-pressed')) };
})()`)
await click('示例：坏 AST 降级'); await sleep(700)
const broken = await evaluate(`(() => { const box = document.querySelector('[data-iui-output]'); return { kind: box?.getAttribute('data-iui-output'), text: (box?.innerText ?? '').slice(0, 120) } })()`)
console.log(JSON.stringify({ before, after, broken, errors }, null, 2))
socket.close()
