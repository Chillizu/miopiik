#!/usr/bin/env node
/** 从真实 DSH 页面读回结构化证据（不写任何东西）。 */
const port = process.env.CDP_PORT ?? '9222'
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.filter((t) => t.type === 'page').find((t) => t.url.includes('127.0.0.1:3080'))
const socket = new WebSocket(page.webSocketDebuggerUrl)
let id = 1
const pending = new Map()
await new Promise((res, rej) => { socket.addEventListener('open', res); socket.addEventListener('error', rej) })
socket.addEventListener('message', (event) => {
  const m = JSON.parse(event.data)
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
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value

const info = await evaluate(`(() => {
  const steps = [...document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')];
  const groups = [...document.querySelectorAll('[data-chat-flow-kind="assistant-step"] [role="group"]')];
  const toolRows = [...document.querySelectorAll('[data-chat-flow-kind="tool-call"]')];
  return {
    assistantSteps: steps.length,
    inlineCards: groups.map((g) => ({ aria: g.getAttribute('aria-label'), h: Math.round(g.getBoundingClientRect().height) })),
    toolRows: toolRows.map((r) => r.textContent.replace(/\\s+/g, ' ').slice(0, 40)),
    bodySnippet: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 600),
    degradedText: [...document.querySelectorAll('[data-chat-flow-kind="assistant-step"] div')].filter((d) => /不合法|降级/.test(d.textContent)).map((d) => d.textContent.trim().slice(0, 80)).slice(0, 4),
    lastStepText: (() => { const steps = [...document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')]; const last = steps[steps.length - 1]; return last ? last.textContent.replace(/\s+/g, ' ').slice(0, 400) : null })(),
    busy: /深度求索|思考中|运行中/.test(document.body.innerText),
    hasMixedTitle: document.body.innerText.includes('混排折线'),
    fenceLiteral: document.body.innerText.includes(String.fromCharCode(96).repeat(3) + 'ink-view'),
    groupLabels: [...document.querySelectorAll('[role="group"][aria-label]')].map((g) => g.getAttribute('aria-label')),
  };
})()`)
console.log(JSON.stringify(info, null, 2))
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
const { writeFileSync } = await import('node:fs')
writeFileSync('.dsh/e2e/full.png', Buffer.from(shot.data, 'base64'))
console.log('full screenshot: .dsh/e2e/full.png')
socket.close()
