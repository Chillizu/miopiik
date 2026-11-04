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

export const LOG_NAMES = Object.freeze(['observations', 'notes', 'loops', 'facts', 'inbox', 'briefings', 'jobs', 'drafts', 'cases', 'branches', 'folds', 'details'])

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
    cases: [],
    branches: new Map(),
    folds: new Map(),
    details: [],
    counters: { obs: 0, note: 0, loop: 0, fact: 0, inbox: 0, job: 0, draft: 0, case: 0, branch: 0, fold: 0 },
    epoch: 0,
  }
}

function bump(counter, id) {
  const match = /-(\d+)$/u.exec(id ?? '')
  if (match === null) return counter
  return Math.max(counter, Number(match[1]))
}

/** 读时迁移：分支上下文切片字段是在分支上线之后才加的，旧记录按空切片补齐。 */
function normalizeBranch(branch) {
  const context = branch?.context ?? {}
  return {
    ...branch,
    context: {
      premise: typeof context.premise === 'string' ? context.premise : '',
      quotes: Array.isArray(context.quotes) ? [...context.quotes] : [],
      facts: Array.isArray(context.facts) ? [...context.facts] : [],
    },
  }
}

/** 系统注入的消息前缀（历史遗留判定，见 §11 数据卫生）。 */
const SYSTEM_PREFIXES = ['<goal_round>', 'Time sampled while preparing', '<goal_round ', '<runtime_context'] 

/** 读时迁移：把历史上被误记为 user 的系统注入消息改判为 system。 */
export function reclassifyLegacyUser(record) {
  if (record?.kind !== 'user' || typeof record.text !== 'string') return record
  const head = record.text.trimStart()
  if (!SYSTEM_PREFIXES.some((prefix) => head.startsWith(prefix))) return record
  return { ...record, kind: 'system', reclassified: 'legacy-user-injection' }
}

/** 把一条记录折叠进内存状态。纯函数式（只改传入的 state）。 */
export function applyRecord(state, log, record) {
  switch (log) {
    case 'observations': {
      // 读时迁移（不改磁盘、保持 append-only）：过滤规则上线前写入的系统注入消息
      // （goal 轮次、时间上下文）曾被记为 user，会让「对话节奏」把系统提示当成用户说的话。
      const migrated = reclassifyLegacyUser(record)
      state.observations.push(migrated)
      state.counters.obs = Math.max(state.counters.obs, migrated.seq ?? 0)
      if (migrated.kind === 'epoch' && Number.isInteger(migrated.epoch)) state.epoch = migrated.epoch
      return
    }
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
    case 'branches': {
      if (record.op === 'create') {
        state.branches.set(record.branch.id, normalizeBranch(record.branch))
        state.counters.branch = bump(state.counters.branch, record.branch.id)
        return
      }
      const branch = state.branches.get(record.branchId)
      if (branch === undefined) return
      if (record.op === 'summary') {
        branch.summary = record.summary
        branch.updatedAt = record.at
      } else if (record.op === 'context') {
        // 切片是追加语义：引用与事实只增不删，前提可被改写（改写本身留痕在日志里）。
        if (typeof record.premise === 'string') branch.context.premise = record.premise
        for (const quote of record.quotes ?? []) {
          if (!branch.context.quotes.includes(quote)) branch.context.quotes.push(quote)
        }
        for (const id of record.facts ?? []) {
          if (!branch.context.facts.includes(id)) branch.context.facts.push(id)
        }
        branch.updatedAt = record.at
      } else if (record.op === 'attach-job') {
        if (!branch.jobs.includes(record.jobId)) branch.jobs.push(record.jobId)
        branch.updatedAt = record.at
      } else if (record.op === 'merge' || record.op === 'abandon') {
        branch.status = record.op === 'merge' ? 'merged' : 'abandoned'
        branch.settledAt = record.at
        branch.mergedInto = record.mergedInto ?? null
        branch.mergedAtTurn = record.turn ?? branch.mergedAtTurn ?? null
        branch.updatedAt = record.at
      }
      return
    }
    case 'details':
      state.details.push(record)
      return
    case 'folds': {
      if (record.op === 'propose') {
        state.folds.set(record.proposal.id, { ...record.proposal })
        state.counters.fold = bump(state.counters.fold, record.proposal.id)
        return
      }
      const proposal = state.folds.get(record.foldId)
      if (proposal === undefined) return
      if (record.op === 'apply' || record.op === 'reject') {
        proposal.status = record.op === 'apply' ? 'applied' : 'rejected'
        proposal.settledAt = record.at
        proposal.settledBy = record.by ?? 'mind'
        proposal.appliedSeq = record.appliedSeq ?? null
        if (typeof record.archive === 'string' && record.archive !== '') proposal.archive = record.archive
      }
      return
    }
    case 'cases':
      state.cases.push(record)
      state.counters.case = Math.max(state.counters.case, Number(String(record.id).replace(/\D/gu, '')) || 0)
      return
    case 'briefings':
      state.briefings.push(record)
      return
    default:
  }
}

/** 打开一个会话的存储目录并回放全部日志。 */
/** 工作区级共享事实：同一目录下的所有会话共用一份知识（SPEC §2.3）。 */
export function sharedFactsPath(dir) {
  return join(dir, 'shared', 'facts.jsonl')
}

/** 打开共享事实文件（不存在就等第一次写入时创建）。 */
export async function openSharedFacts(dir) {
  const path = sharedFactsPath(dir)
  await mkdir(join(dir, 'shared'), { recursive: true })
  const state = emptyState('shared')
  let text = ''
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      applyRecord(state, 'facts', JSON.parse(line))
    } catch {
      // 坏行跳过：共享文件同样是可肉眼审计的明文。
    }
  }
  return { dir, path, state }
}

export async function appendSharedFact(shared, record) {
  await appendFile(shared.path, `${JSON.stringify(record)}\n`, 'utf8')
  applyRecord(shared.state, 'facts', record)
  return record
}

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
  // 共享事实并入本会话视图：谁在同一个工作区里发现过什么，别人打开就能用。
  const shared = await openSharedFacts(dir)
  for (const [id, fact] of shared.state.facts) {
    if (!state.facts.has(id)) state.facts.set(id, fact)
  }
  return { dir, state, shared }
}

/** 追加一条记录：先落盘，再进内存（失败即抛，不吞）。 */
export async function appendRecord(store, log, record) {
  await appendFile(join(store.dir, `${log}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8')
  applyRecord(store.state, log, record)
  return record
}
