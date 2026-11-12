#!/usr/bin/env node
/** 在真实 DSH 会话里发一条消息并等回合结束（用于补充冒烟场景）。 */
const port = process.env.CDP_PORT ?? '9222'
const text = process.argv.slice(2).join(' ')
if (text === '') throw new Error('需要消息文本')
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const inserted = await evaluate(`(() => {
  const el = document.querySelector('textarea, [contenteditable="true"]');
  if (!el) return 'no-input';
  el.focus();
  document.execCommand('insertText', false, ${JSON.stringify(text)});
  return 'inserted';
})()`)
await sleep(400)
const typed = await evaluate(`(() => {
  const el = document.querySelector('textarea, [contenteditable="true"]');
  const value = (el?.value ?? el?.innerText ?? '').trim();
  return value.length > 0 ? 'typed:' + value.length : 'empty';
})()`)
void typed
await sleep(500)
await evaluate(`(() => { const b = [...document.querySelectorAll('button[aria-label]')].find((x) => /发送|Send/i.test(x.getAttribute('aria-label') || '')); b?.click(); return !!b })()`)
let stable = 0
let last = -1
for (let i = 0; i < 90; i += 1) {
  await sleep(2000)
  const len = await evaluate('document.body.innerText.length')
  const busy = await evaluate('/深度求索|思考中/.test(document.body.innerText)')
  if (len === last && busy === false) { stable += 1; if (stable >= 2) break } else stable = 0
  last = len
}
console.log('typed=' + typed)
socket.close()
