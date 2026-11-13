/**
 * 跨天验收（SPEC §10 的 1/2/3）—— 不模拟「第二天」这个动作，而是模拟它真实的形态：
 * 进程重启后，从**昨天的账本文件**恢复，看 L3 给出什么。
 *
 * 这三条验收本来就是「用户第二天回来时的体验」，所以被测对象是恢复路径本身。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openStore } from '../host/store.js'
import { Engine } from '../host/engine.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()
const TODAY = Math.floor(NOW / DAY)
const YESTERDAY = TODAY - 1

/** 写一份「昨天的账本」：对话、开环、简报都在。 */
async function writeYesterday(dir) {
  const obs = [
    { seq: 1, at: (YESTERDAY + 0.4) * DAY, day: YESTERDAY, turn: 3, kind: 'user', epoch: 0, text: '我们做分支上下文切片吧' },
    {
      seq: 2,
      at: (YESTERDAY + 0.45) * DAY,
      day: YESTERDAY,
      turn: 3,
      kind: 'assistant',
      epoch: 0,
      text: '好，我开一条分支，把前提和依赖的事实卡带上',
    },
    { seq: 3, at: (YESTERDAY + 0.5) * DAY, day: YESTERDAY, turn: 3, kind: 'turn-end', epoch: 0, text: '' },
  ]
  const loops = [
    {
      op: 'create',
      loop: {
        id: 'L-7',
        text: '草稿态免门槛派发还没做',
        type: 'forming-intent',
        pointer: null,
        closureCondition: '草稿可以直接派发、不必补齐六要素',
        status: 'active',
        turn: 3,
        epoch: 0,
        createdAt: (YESTERDAY + 0.5) * DAY,
        lastTouchedAt: (YESTERDAY + 0.5) * DAY,
        lastTouchedDay: YESTERDAY,
        closedAt: null,
        closedBy: null,
      },
    },
  ]
  const briefings = [
    {
      day: YESTERDAY,
      at: (YESTERDAY + 0.6) * DAY,
      progress: '分支切片做完并验证（Operator 零工具调用答对）',
      loops: 'L-7 草稿态免门槛派发',
      running: '无',
      drafts: '无',
      next: '明天先做草稿态派发，再考虑自动收工',
    },
  ]

  await appendFile(join(dir, 'observations.jsonl'), obs.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  await appendFile(join(dir, 'loops.jsonl'), loops.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  await appendFile(join(dir, 'briefings.jsonl'), briefings.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
}

test('§10.1 第二天开工：用户不用问「我们在干嘛」——L3 自己带上交接简报', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'miopiik-crossday-'))
  try {
    await writeYesterday(dir)
    const store = await openStore(dir, 's1')
    const engine = new Engine({ store, sessionId: 's1' }) // 真实时间：今天
    const l3 = engine.l3Text()

    assert.match(l3, /## 交接简报/)
    assert.match(l3, /分支切片做完并验证/)
    assert.match(l3, /下步（你昨天想的）：明天先做草稿态派发/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('§10.2 「继续昨天那个」：能精确说出停在哪一条，不用重读记录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'miopiik-crossday-'))
  try {
    await writeYesterday(dir)
    const store = await openStore(dir, 's1')
    const engine = new Engine({ store, sessionId: 's1' })
    const l3 = engine.l3Text()

    assert.match(l3, /\[L-7\] 草稿态免门槛派发还没做/)
    assert.match(l3, /闭合条件：草稿可以直接派发/)
    // 昨天那两句原话仍然可被指认（U-id），不是靠"回忆"
    const utterances = engine.utteranceIndex()
    assert.equal(utterances[0].id, 'U-2')
    assert.match(utterances[0].text, /我开一条分支/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('§10.3 简报一屏内，且含 Mind 自己的下一步意见', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'miopiik-crossday-'))
  try {
    await writeYesterday(dir)
    const store = await openStore(dir, 's1')
    const engine = new Engine({ store, sessionId: 's1' })
    const briefing = engine.latestBriefing()

    assert.ok(briefing !== null)
    assert.ok(briefing.next.length > 0, '「下步」是 Mind 的意见，不能空着')
    const rendered = [briefing.progress, briefing.loops, briefing.running, briefing.drafts, briefing.next].join('')
    assert.ok(rendered.length < 1800, `简报应在单屏内，实际 ${rendered.length} 字`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('§10.4 隔夜零噪音：恢复时不写对话、不主动产生收件箱条目', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'miopiik-crossday-'))
  try {
    await writeYesterday(dir)
    const before = await openStore(dir, 's1')
    const beforeNotes = before.state.notes.length
    const beforeInbox = before.state.inbox.size

    const store = await openStore(dir, 's1')
    const engine = new Engine({ store, sessionId: 's1' })
    engine.l3Text() // 只读，不该产生副作用

    assert.equal(engine.state.notes.length, beforeNotes, '恢复过程不新增 note')
    assert.equal(engine.state.inbox.size, beforeInbox, '恢复过程不新增收件箱条目')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
