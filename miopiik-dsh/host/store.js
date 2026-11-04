/**
 * 观测日志 / 决定账的落盘与回放 —— SPEC §2.1 / §2.2。
 *
 * 采用 append-only JSONL（无损存储，有损上下文）：重启即回放，不依赖第三方存储服务。
 * 这是对 SPEC「实现偏差」事项之一：DSH 的 storageDomain 需要一个 zod schema 与
 * 运行时导入，而 workspace link 安装拿不到 @deepseek-ai 运行时依赖；因此改为
 * 可肉眼审计的 JSONL 文件。语义不变：同样 append-only、同样可回放。
 */

import { mkdir, readFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

export const LOG_NAMES = Object.freeze(['observations', 'notes', 'loops', 'facts', 'inbox', 'briefings', 'jobs', 'drafts'])

export function emptyState(sessionId) {
  return {
    sessionId,
    observations: [],
    notes: [],
    loops: new Map(),
    facts: new Map(),
    inbox: new Map(),
    briefings: [],
    jobs: new Map(),
    drafts: new Map(),
    counters: { obs: 0, note: 0, loop: 0, fact: 0, inbox: 0, job: 0, draft: 0 },
    epoch: 0,
  }
}

function bump(counter, id) {
  const match = /-(\d+)$/u.exec(id ?? '')
  if (match === null) return counter
  return Math.max(counter, Number(match[1]))
}

/** 把一条记录折叠进内存状态。纯函数式（只改传入的 state）。 */
export function applyRecord(state, log, record) {
  switch (log) {
    case 'observations':
      state.observations.push(record)
      state.counters.obs = Math.max(state.counters.obs, record.seq ?? 0)
      if (record.kind === 'epoch' && Number.isInteger(record.epoch)) state.epoch = record.epoch
      return
    case 'notes':
      state.notes.push(record)
      state.counters.note = bump(state.counters.note, record.id)
      return
    case 'loops': {
      const loop = state.loops.get(record.loopId)
      if (record.op === 'create') {
        state.loops.set(record.loop.id, { ...record.loop })
        state.counters.loop = bump(state.counters.loop, record.loop.id)
        return
      }
      if (loop === undefined) return
      if (record.op === 'touch') {
        loop.lastTouchedAt = record.at
        loop.lastTouchedDay = record.day
        loop.turn = record.turn ?? loop.turn
        loop.epoch = record.epoch ?? loop.epoch
        if (loop.status === 'dormant' || loop.status === 'folded') loop.status = 'active'
      } else if (record.op === 'status') {
        loop.status = record.status
      } else if (record.op === 'close') {
        loop.status = 'closed'
        loop.closedAt = record.at
        loop.closedBy = record.by ?? 'mind'
      } else if (record.op === 'drop') {
        loop.status = 'dropped'
        loop.closedAt = record.at
        loop.closedBy = record.by ?? 'mind'
      }
      return
    }
    case 'facts': {
      if (record.op === 'add') {
        state.facts.set(record.fact.id, { ...record.fact })
        state.counters.fact = bump(state.counters.fact, record.fact.id)
        return
      }
      const fact = state.facts.get(record.factId)
      if (fact === undefined) return
      if (record.op === 'revise') {
        Object.assign(fact, record.patch ?? {})
        fact.revisedAt = record.at
      } else if (record.op === 'invalidate') {
        fact.stale = true
        fact.invalidatedAt = record.at
        fact.invalidatedReason = record.reason ?? null
      }
      return
    }
    case 'inbox': {
      if (record.op === 'deliver') {
        state.inbox.set(record.item.id, { ...record.item })
        state.counters.inbox = bump(state.counters.inbox, record.item.id)
        return
      }
      const item = state.inbox.get(record.itemId)
      if (item === undefined) return
      if (record.op === 'read') item.status = 'read'
      else if (record.op === 'star') item.status = 'starred'
      else if (record.op === 'unstar') item.status = 'unread'
      else if (record.op === 'defer') item.status = 'deferred'
      else if (record.op === 'supersede') item.status = 'superseded'
      return
    }
    case 'jobs': {
      if (record.op === 'create') {
        state.jobs.set(record.job.id, { ...record.job })
        state.counters.job = bump(state.counters.job, record.job.id)
        return
      }
      const job = state.jobs.get(record.jobId)
      if (job === undefined) return
      if (record.op === 'update') Object.assign(job, record.patch ?? {})
      return
    }
    case 'drafts': {
      if (record.op === 'create') {
        state.drafts.set(record.draft.id, { ...record.draft })
        state.counters.draft = bump(state.counters.draft, record.draft.id)
        return
      }
      const draft = state.drafts.get(record.draftId)
      if (draft === undefined) return
      if (record.op === 'update') Object.assign(draft, record.patch ?? {})
      return
    }
    case 'briefings':
      state.briefings.push(record)
      return
    default:
  }
}

/** 打开一个会话的存储目录并回放全部日志。 */
export async function openStore(dir, sessionId) {
  await mkdir(dir, { recursive: true })
  const state = emptyState(sessionId)
  for (const log of LOG_NAMES) {
    let text = ''
    try {
      text = await readFile(join(dir, `${log}.jsonl`), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        applyRecord(state, log, JSON.parse(line))
      } catch {
        // 坏行跳过：文件仍可肉眼审计，不让一行坏数据毁掉整个回放。
      }
    }
  }
  return { dir, state }
}

/** 追加一条记录：先落盘，再进内存（失败即抛，不吞）。 */
export async function appendRecord(store, log, record) {
  await appendFile(join(store.dir, `${log}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8')
  applyRecord(store.state, log, record)
  return record
}
