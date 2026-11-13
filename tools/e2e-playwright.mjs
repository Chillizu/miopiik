#!/usr/bin/env node
/**
 * MiOpIIk IUI standalone production-path E2E:
 * DSH Plugins page + native settings + actual renderer/interaction + browser preference.
 * Isolated Chromium context; no messages are ever sent to DSH.
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire('/home/chillizu/.dsh/profiles/web/node_modules/')
const { chromium } = require('playwright')
const BASE = 'http://127.0.0.1:3080'
const evidence = { errors: [], checks: [] }
const record = (name, props) => evidence.checks.push({ name, ...props })
const assert = (condition, detail) => { if (!condition) evidence.errors.push(detail) }
function loginUrl() {
  const log = execFileSync('journalctl', ['--user','-u','dsh-web.service','--since','9 hours ago','-o','cat','--no-pager'], {encoding:'utf8'})
  const matches = [...log.matchAll(/http:\/\/127\.0\.0\.1:3080\/\?token=([A-Za-z0-9_-]+)/gu)]
  if (matches.length === 0) throw new Error('no local DSH auth entry')
  return BASE + '/?token=' + matches.at(-1)[1]
}
async function openSettings(page) {
  await page.getByRole('button', { name: '插件', exact: true }).click()
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: '查看 miopiik-iui', exact: true }).click()
  await page.waitForTimeout(650)
  const panel=page.locator('[data-iui-plugin-settings="1"]')
  await panel.waitFor({state:'visible',timeout:8000})
  return panel
}
async function run(context,width=1280) {
  const page = await context.newPage()
  const jsErrors=[]
  page.on('pageerror',e=>jsErrors.push(String(e).slice(0,180)))
  await page.goto(loginUrl(),{waitUntil:'domcontentloaded'})
  await page.waitForTimeout(1350)
  const panel=await openSettings(page)
  const ready=(await panel.locator('[data-iui-registry-state]').getAttribute('data-iui-registry-state'))==='ready'
  const enabled=(await panel.locator('[data-iui-settings-status]').getAttribute('data-iui-settings-status'))==='enabled'
  const live=(await panel.locator('[data-iui-settings-preview]').getAttribute('data-iui-settings-preview'))==='live'
  const count=await panel.locator('[data-iui-output="ok"]').count()
  const switcher=panel.locator('[data-iui-settings-toggle="1"]')
  const checked=await switcher.getAttribute('aria-checked')
  const metrics=()=>panel.locator('[data-iui-metric]').allTextContents()
  const before=await metrics()
  const stepBefore=await page.locator('[data-chat-flow-kind="assistant-step"]').count()
  const opt=panel.getByRole('button',{name:'近 30 天',exact:true})
  let changed=false
  if(await opt.count()===1){
    await opt.click();await page.waitForTimeout(450)
    const after=await metrics()
    changed=after.join('|')!==before.join('|')&&after.join('|').includes('4,826')
  }
  const added=(await page.locator('[data-chat-flow-kind="assistant-step"]').count())-stepBefore
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+3)
  const oldView=await page.getByText('视图',{exact:true}).count()
  const data={width,ready,enabled,live,count,checked,changed,added,overflow,oldView,jsErrors}
  record('native-settings',data)
  assert(ready&&enabled&&live&&count>0&&checked==='true','Standalone settings not fully ready')
  assert(changed&&added===0,'Native preview interaction did not update locally')
  assert(!overflow&&jsErrors.length===0,'Page overflow or JavaScript error')
  await context.close()
}

const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-gpu']})
try {
  const normal=await browser.newContext({viewport:{width:1280,height:900}})
  await run(normal,1280)
  const narrow=await browser.newContext({viewport:{width:420,height:860}})
  await run(narrow,420)
} finally {await browser.close()}
console.log(JSON.stringify({ok:evidence.errors.length===0,evidence},null,2))
process.exitCode=evidence.errors.length===0?0:1
