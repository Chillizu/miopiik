#!/usr/bin/env node
/**
 * 打开 DSH WebUI 并回信用 cookie（token 只在进程内使用，绝不打印）。
 *   node tools/dsh-open.mjs            # 换票并打开首页
 *   node tools/dsh-open.mjs /some/path # 换票后跳指定路径
 * CDP 端口默认 9222（CDP_PORT 可覆盖）。
 */
import { execFileSync } from 'node:child_process'

const port = process.env.CDP_PORT ?? '9222'
const base = `http://127.0.0.1:${port}`
const targetPath = process.argv[2] ?? '/'

async function targets() {
  const response = await fetch(`${base}/json/list`)
  if (!response.ok) throw new Error(`CDP 不可用：${response.status}`)
  return response.json()
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    let id = 1
    const pending = new Map()
    socket.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          const callId = id++
          return new Promise((res, rej) => {
            pending.set(callId, { res, rej })
            socket.send(JSON.stringify({ id: callId, method, params }))
          })
        },
        close: () => socket.close(),
      }),
    )
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const call = pending.get(message.id)
      if (call === undefined) return
      pending.delete(message.id)
      message.error ? call.rej(new Error(message.error.message)) : call.res(message.result)
    })
    socket.addEventListener('error', reject)
  })
}

function tokenUrl() {
  const log = execFileSync('journalctl', ['--user', '-u', 'dsh-web', '-o', 'cat'], { encoding: 'utf8' })
  const match = [...log.matchAll(/http:\/\/127\.0\.0\.1:3080\/\?token=([A-Za-z0-9_-]+)/gu)].pop()
  if (match === undefined) throw new Error('日志里没有可用 token')
  return { url: `http://127.0.0.1:3080/?token=${match[1]}`, token: match[1] }
}

let pages = (await targets()).filter((target) => target.type === 'page')
let page = pages.find((target) => target.url.includes('127.0.0.1:3080'))
if (page === undefined) {
  // 没有 DSH 标签页就新建一个（token 只在进程内使用）
  const helper = tokenUrl()
  const created = await fetch(`${base}/json/new?${encodeURIComponent(helper.url)}`, { method: 'PUT' }).then((r) => r.json())
  page = created
  pages = [created]
}
if (page === undefined) throw new Error('没有可用标签页')
const cdp = await connect(page.webSocketDebuggerUrl)
try {
  await cdp.send('Page.enable')
  const { url } = tokenUrl()
  await cdp.send('Page.navigate', { url })
  await new Promise((r) => setTimeout(r, 2500))
  const info = await cdp.send('Runtime.evaluate', {
    expression: 'JSON.stringify({ title: document.title, path: location.pathname, hash: location.hash.slice(0, 40), session: (document.body.innerText.match(/MiOpIIk|新会话/) || [null])[0] })',
    returnByValue: true,
  })
  if (targetPath !== '/') {
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:3080${targetPath}` })
  }
  console.log('已登录并打开', info.result?.value ?? '')
} finally {
  cdp.close()
}
