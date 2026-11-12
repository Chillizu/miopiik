#!/usr/bin/env node
/** 重载页面并抓 console/异常，判断渲染层是否报错。 */
const port = process.env.CDP_PORT ?? '9222'
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.filter((t) => t.type === 'page').find((t) => t.url.includes('127.0.0.1:3080'))
const socket = new WebSocket(page.webSocketDebuggerUrl)
let id = 1
const pending = new Map()
const out = []
await new Promise((res, rej) => { socket.addEventListener('open', res); socket.addEventListener('error', rej) })
socket.addEventListener('message', (event) => {
  const m = JSON.parse(event.data)
  if (m.method === 'Runtime.consoleAPICalled') {
    out.push('CONSOLE[' + m.params.type + '] ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 240))
  }
  if (m.method === 'Runtime.exceptionThrown') {
    out.push('EXCEPTION ' + String(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? '').slice(0, 300))
  }
  const call = pending.get(m.id)
  if (call === undefined) return
  pending.delete(m.id)
  m.error ? call.rej(new Error(m.error.message)) : call.res(m.result)
})
const send = (method, params = {}) => new Promise((res, rej) => {
  const callId = id++
  pending.set(callId, { res, rej })
  socket.send(JSON.stringify({ id: callId, method, params }))
})
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value
await send('Runtime.enable')
await send('Page.enable')
await send('Page.reload', { ignoreCache: true })
await new Promise((r) => setTimeout(r, 5000))
const state = await evaluate(`(() => {
  const steps = [...document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')];
  return {
    steps: steps.length,
    empty: steps.filter((s) => s.textContent.trim() === '').length,
    groups: [...document.querySelectorAll('[role="group"][aria-label]')].map((g) => g.getAttribute('aria-label')),
    bodyLen: document.body.innerText.length,
  };
})()`)
console.log(JSON.stringify({ state, errors: out.slice(-12) }, null, 2))
socket.close()
