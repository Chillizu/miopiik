#!/usr/bin/env node
/** 一次性证据：独立卡数量与标签、正文里的拒绝/降级关键词、console 错误。 */
const port = process.env.CDP_PORT ?? '9222'
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.filter((t) => t.type === 'page').find((t) => t.url.includes('127.0.0.1:3080'))
const socket = new WebSocket(page.webSocketDebuggerUrl)
let id = 1
const pending = new Map()
const logs = []
await new Promise((res, rej) => { socket.addEventListener('open', res); socket.addEventListener('error', rej) })
socket.addEventListener('message', (event) => {
  const m = JSON.parse(event.data)
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('CONSOLE ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 160))
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + String(m.params?.exceptionDetails?.exception?.description ?? '').slice(0, 200))
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
const evidence = await evaluate(`(() => {
  const text = document.body.innerText;
  const nodes = [...document.querySelectorAll('[data-chat-flow-kind="miopiik-widget"]')];
  const steps = [...document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')];
  return {
    cards: nodes.map((n) => n.querySelector('[role="group"]')?.getAttribute('aria-label') ?? n.textContent.slice(0, 20)),
    stepTextLens: steps.map((s) => s.textContent.trim().length),
    rejections: {
      nullNode: /节点必须是对象|graph 第 1 个节点/.test(text),
      layoutChild: /子项不合法|未知 widget: mermaid/.test(text),
      badChart: /chart 只能是/.test(text),
    },
    hasDONE: /DONE/.test(text),
    hasValidGraphCard: /合法图/.test(text),
    consoleErrors: null,
  };
})()`)
console.log(JSON.stringify({ evidence, consoleErrors: logs.slice(-8) }, null, 2))
socket.close()
