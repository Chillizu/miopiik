#!/usr/bin/env node
/**
 * 极简 CDP 客户端：接管一个已开调试口的 Chrome（保留登录态），做一次性动作。
 *
 *   node tools/cdp.mjs list
 *   node tools/cdp.mjs open  https://chatgpt.com/...
 *   node tools/cdp.mjs eval  "document.title"
 *   node tools/cdp.mjs shot  out.png
 *
 * 端口默认 9222，可用 CDP_PORT 覆盖。只用 Node 自带的 fetch / WebSocket（Node >= 22）。
 */
const port = process.env.CDP_PORT ?? '9222'
const base = `http://127.0.0.1:${port}`
const [, , command, ...rest] = process.argv

async function targets() {
  const response = await fetch(`${base}/json/list`)
  if (!response.ok) throw new Error(`CDP 列表失败：${response.status}（Chrome 没开调试口？）`)
  return response.json()
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    let nextId = 1
    const pending = new Map()
    socket.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          const id = nextId++
          return new Promise((resolveCall, rejectCall) => {
            pending.set(id, { resolveCall, rejectCall })
            socket.send(JSON.stringify({ id, method, params }))
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
      if (message.error) call.rejectCall(new Error(message.error.message))
      else call.resolveCall(message.result)
    })
    socket.addEventListener('error', reject)
  })
}

async function main() {
  if (command === 'list') {
    for (const target of await targets()) {
      if (target.type !== 'page') continue
      console.log(`${target.title}\t${target.url}`)
    }
    return
  }
  const pages = (await targets()).filter((target) => target.type === 'page')
  if (pages.length === 0) throw new Error('没有可用的页面')
  // 优先挑 chatgpt 的标签页；否则用第一个
  const page = pages.find((target) => target.url.includes('chatgpt.com')) ?? pages[0]
  const cdp = await connect(page.webSocketDebuggerUrl)
  try {
    if (command === 'open') {
      await cdp.send('Page.enable')
      await cdp.send('Page.navigate', { url: rest[0] })
      console.log('navigated', rest[0])
      return
    }
    if (command === 'eval') {
      const result = await cdp.send('Runtime.evaluate', { expression: rest.join(' '), awaitPromise: true, returnByValue: true })
      console.log(JSON.stringify(result.result?.value ?? result, null, 2))
      return
    }
    if (command === 'shot') {
      const result = await cdp.send('Page.captureScreenshot', { format: 'png' })
      const { writeFileSync } = await import('node:fs')
      writeFileSync(rest[0] ?? 'cdp-shot.png', Buffer.from(result.data, 'base64'))
      console.log('saved', rest[0] ?? 'cdp-shot.png')
      return
    }
    throw new Error(`未知命令：${command}`)
  } finally {
    cdp.close()
  }
}

main().catch((error) => {
  console.error(String(error?.message ?? error))
  process.exitCode = 1
})
