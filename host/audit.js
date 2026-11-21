/**
 * 后台流水的全量取数通道 —— SPEC §2.2「账本是数据」。
 *
 * 与 snapshot.audit 的尾部采样不同：这里直接读会话目录的 JSONL 原始日志
 * （append-only，回放即真相），把每一条可重建操作的记录映射成统一行形状，
 * 按 (at, seq) 新者在前排序，供 auditPage 按天/游标翻页。
 *
 * 纯函数模块：不碰 Engine 状态、不写文件；Engine 只是提供目录与分页入参。
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dayOf } from './loops.js'

/** 参与流水的日志：观测里只取 epoch 与 compaction 折叠（对话原文归主界面，不重复进流水）。 */
export const AUDIT_LOGS = Object.freeze(['notes', 'loops', 'facts', 'inbox', 'briefings', 'jobs', 'drafts', 'branches', 'folds', 'observations'])

/** 单页上限：命令通道的返回文本会进 command/done 事件，不能无限大。 */
export const AUDIT_PAGE_MAX = 200
export const AUDIT_PAGE_DEFAULT = 50

function short(value, max = 200) {
  const text = String(value ?? '').trim()
  return text === '' ? null : text.slice(0, max)
}

/** 读一个日志文件的全部记录（坏行跳过，与 store 回放同一容错策略）。 */
function readLog(path) {
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const records = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // 坏行跳过：文件仍可肉眼审计。
    }
  }
  return records
}

/** 第一遍扫 create 记录，建 id → 摘要索引，供后续 op 记录引用正文与归属。 */
function buildIndex(log, records) {
  const index = new Map()
  for (const record of records) {
    if (log === 'loops' && record.op === 'create') index.set(record.loop?.id, { text: record.loop?.text })
    if (log === 'facts' && record.op === 'add') index.set(record.fact?.id, { claim: record.fact?.claim })
    if (log === 'inbox' && record.op === 'deliver') index.set(record.item?.id, { claim: record.item?.claim, branchId: record.item?.branchId ?? null })
    if (log === 'jobs' && record.op === 'create') index.set(record.job?.id, { label: record.job?.label, branchId: record.job?.branchId ?? null })
    if (log === 'drafts' && record.op === 'create') index.set(record.draft?.id, { title: record.draft?.title })
    if (log === 'branches' && record.op === 'create') index.set(record.branch?.id, { label: record.branch?.label })
  }
  return index
}

/**
 * 统一行形状：{ id, at, day, kind, actor, claim, refs, branch?, detail? }。
 * id 是操作对象的账本 id（同一对象的多条操作行共用 id，靠 kind/at 区分）。
 * actor 只写记录里真正可判定的字段，判不出的用引擎默认（不凭空造）。
 */
function mapRecord(log, record, index, { sharedScope = false } = {}) {
  if (record === null || typeof record !== 'object') return null
  const base = (at, kind, actor, claim, refs, extra = {}) => {
    if (!Number.isFinite(at)) return null
    const row = { id: String(extra.id ?? ''), at, day: dayOf(at), kind, actor, claim: String(claim ?? ''), refs }
    if (extra.branch !== undefined && extra.branch !== null) row.branch = extra.branch
    const detail = short(extra.detail)
    if (detail !== null) row.detail = detail
    return row
  }
  const summaryOf = (id, field, fallback) => {
    const hit = index.get(String(id ?? ''))
    return hit?.[field] ?? fallback ?? String(id ?? '')
  }

  switch (log) {
    case 'notes': {
      // note 的 kind 直接用账本子类（absorb/answer/hold/preview…），流水里它就是操作名。
      if (typeof record.id !== 'string') return null
      return base(record.at, String(record.kind ?? 'note'), 'ink', record.claim, Array.isArray(record.refs) ? record.refs : [], {
        id: record.id,
        branch: record.branch ?? null,
        detail: record.detail ?? record.question ?? null,
      })
    }
    case 'observations': {
      // 观测只收两类后台事件：epoch 迁移与 compaction 折叠；user/assistant/tool 是对话原文，不重复进流水。
      if (record.kind !== 'epoch' && record.kind !== 'fold') return null
      const at = record.at ?? 0
      return base(at, record.kind === 'epoch' ? 'epoch' : 'fold.compaction', 'ink', record.text ?? '', [], {
        id: `obs-${record.seq ?? at}`,
      })
    }
    case 'loops': {
      if (record.op === 'create') {
        const loop = record.loop ?? {}
        const at = loop.createdAt ?? loop.lastTouchedAt ?? 0
        return base(at, 'loop.add', 'ink', loop.text ?? loop.id, [loop.id], {
          id: loop.id,
          detail: [loop.type, loop.closureCondition ? `闭合条件：${loop.closureCondition}` : null].filter(Boolean).join('｜'),
        })
      }
      const at = record.at ?? 0
      const id = record.loopId ?? null
      if (record.op === 'touch') {
        return base(at, 'loop.touch', 'ink', summaryOf(id, 'text', id), [id], { id })
      }
      if (record.op === 'status') {
        return base(at, 'loop.status', 'ink', summaryOf(id, 'text', id), [id], { id, detail: `状态 → ${record.status}` })
      }
      if (record.op === 'close' || record.op === 'drop') {
        return base(at, `loop.${record.op}`, record.by ?? 'mind', summaryOf(id, 'text', id), [id], {
          id,
          detail: record.reason ?? null,
        })
      }
      return null
    }
    case 'facts': {
      if (record.op === 'add') {
        const fact = record.fact ?? {}
        const at = fact.createdAt ?? fact.revisedAt ?? 0
        return base(at, 'fact.add', fact.source ?? 'ink', fact.claim ?? fact.id, [fact.id], {
          id: fact.id,
          detail: [`conf ${fact.conf ?? ''}`, sharedScope ? 'scope: workspace' : fact.scope ? `scope: ${fact.scope}` : null]
            .filter(Boolean)
            .join('｜'),
        })
      }
      const at = record.at ?? 0
      const id = record.factId ?? null
      if (record.op === 'revise') {
        const patch = record.patch ?? {}
        return base(at, 'fact.revise', 'ink', patch.claim ?? summaryOf(id, 'claim', id), [id], {
          id,
          detail: `改写：${Object.keys(patch).filter((key) => key !== 'revisedAt').join('、') || '（空）'}`,
        })
      }
      if (record.op === 'invalidate') {
        const actor = record.reason === 'intervention:ui' ? 'user' : 'ink'
        return base(at, 'fact.invalidate', actor, summaryOf(id, 'claim', id), [id], { id, detail: record.reason ?? null })
      }
      return null
    }
    case 'inbox': {
      if (record.op === 'deliver') {
        const item = record.item ?? {}
        const at = item.createdAt ?? 0
        return base(at, 'inbox.deliver', 'ink', item.claim ?? item.id, [item.id, item.noteId, item.loopId].filter(Boolean), {
          id: item.id,
          branch: item.branchId ?? null,
          detail: item.question ?? null,
        })
      }
      const at = record.at ?? 0
      const id = record.itemId ?? null
      const ops = { read: 'read', star: 'star', unstar: 'unstar', defer: 'defer', supersede: 'supersede' }
      if (ops[record.op] === undefined) return null
      const summary = index.get(String(id ?? ''))
      return base(at, `inbox.${ops[record.op]}`, record.op === 'supersede' ? 'ink' : 'mind', summary?.claim ?? String(id ?? ''), [id], {
        id,
        branch: summary?.branchId ?? null,
      })
    }
    case 'jobs': {
      if (record.op === 'create') {
        const job = record.job ?? {}
        const at = job.createdAt ?? 0
        return base(at, 'job.dispatch', 'operator', job.label ?? job.id, [job.id, job.loopId].filter(Boolean), {
          id: job.id,
          branch: job.branchId ?? null,
          detail: job.contract?.goal ? `契约：${job.contract.goal}` : null,
        })
      }
      if (record.op === 'update') {
        const patch = record.patch ?? {}
        const id = record.jobId ?? null
        const parts = []
        if (patch.state !== undefined) parts.push(`状态 → ${patch.state}`)
        if (patch.stopReason !== undefined && patch.stopReason !== null) parts.push(`stopReason: ${patch.stopReason}`)
        if (patch.childId !== undefined) parts.push(`childId: ${patch.childId}`)
        if (patch.endedAt !== undefined) parts.push('已结束')
        const summary = index.get(String(id ?? ''))
        return base(record.at ?? 0, 'job.update', 'operator', summary?.label ?? String(id ?? ''), [id], {
          id,
          branch: summary?.branchId ?? null,
          detail: parts.join('｜'),
        })
      }
      return null
    }
    case 'drafts': {
      if (record.op === 'create') {
        const draft = record.draft ?? {}
        const at = draft.createdAt ?? 0
        return base(at, 'draft.add', draft.source ?? 'mind', draft.title ?? draft.id, [draft.id], {
          id: draft.id,
          detail: draft.summary ?? null,
        })
      }
      if (record.op === 'update') {
        const patch = record.patch ?? {}
        const id = record.draftId ?? null
        return base(record.at ?? 0, 'draft.settle', patch.status === 'expired' ? 'ink' : 'mind', summaryOf(id, 'title', id), [id], {
          id,
          detail: [patch.status, patch.settleReason].filter((part) => part !== null && part !== undefined).join('（') + (patch.settleReason ? '）' : ''),
        })
      }
      return null
    }
    case 'branches': {
      if (record.op === 'create') {
        const branch = record.branch ?? {}
        const at = branch.createdAt ?? 0
        return base(at, 'branch.fork', 'mind', branch.label ?? branch.id, [branch.id], {
          id: branch.id,
          branch: branch.id,
          detail: branch.summary ?? branch.context?.premise ?? null,
        })
      }
      const at = record.at ?? 0
      const id = record.branchId ?? null
      const label = summaryOf(id, 'label', id)
      if (record.op === 'summary') {
        return base(at, 'branch.summary', 'mind', label, [id], { id, branch: id, detail: record.summary ?? null })
      }
      if (record.op === 'context') {
        return base(at, 'branch.context', 'mind', label, [id], {
          id,
          branch: id,
          detail: [
            record.premise ? `前提改写：${record.premise}` : null,
            Array.isArray(record.quotes) && record.quotes.length > 0 ? `引用 +${record.quotes.length}` : null,
            Array.isArray(record.facts) && record.facts.length > 0 ? `事实 +${record.facts.length}` : null,
          ]
            .filter(Boolean)
            .join('｜'),
        })
      }
      if (record.op === 'attach-job') {
        return base(at, 'branch.attach-job', 'ink', label, [id, record.jobId], { id, branch: id, detail: `任务 ${record.jobId ?? ''}` })
      }
      if (record.op === 'merge') {
        return base(at, 'branch.merge', 'mind', label, [id, record.mergedInto].filter(Boolean), {
          id,
          branch: id,
          detail: record.mergedInto ? `汇回为 ${record.mergedInto}` : null,
        })
      }
      if (record.op === 'abandon') {
        return base(at, 'branch.abandon', 'mind', label, [id], { id, branch: id, detail: record.reason ?? null })
      }
      return null
    }
    case 'briefings': {
      const at = record.at ?? 0
      if (record.kind === undefined || record.kind === null) {
        return base(at, 'briefing', 'mind', record.progress ?? '交接简报', [], {
          id: `briefing-${record.day}-${at}`,
          detail: [record.loops, record.running, record.drafts, record.next].filter(Boolean).join('｜') || null,
        })
      }
      if (record.kind === 'overnight') {
        return base(at, 'briefing.overnight', 'mind', record.text ?? '', [], { id: `briefing-${at}` })
      }
      if (record.kind === 'auto-materials') {
        return base(at, 'briefing.auto-materials', 'ink', `第 ${record.day} 天的盘外素材`, [], { id: `briefing-${at}` })
      }
      if (record.kind === 'closing-signal') {
        return base(at, 'briefing.closing-signal', 'ink', `用户像在收工：「${record.quote ?? ''}」`, [], { id: `briefing-${at}` })
      }
      if (record.kind === 'hard-break') {
        return base(at, 'briefing.hard-break', 'ink', `停在第 ${record.day} 天，没有收工简报`, [], { id: `briefing-${at}` })
      }
      return null
    }
    case 'folds': {
      if (record.op === 'propose') {
        const proposal = record.proposal ?? {}
        const at = proposal.createdAt ?? 0
        return base(at, 'fold.propose', 'ink', `折叠档案 ${String(proposal.archive ?? '').length} 字（覆盖 ${proposal.covered ?? 0}/${proposal.total ?? 0}）`, [proposal.id], {
          id: proposal.id,
        })
      }
      const at = record.at ?? 0
      const id = record.foldId ?? null
      if (record.op === 'apply' || record.op === 'reject') {
        return base(at, `fold.${record.op}`, record.by ?? 'mind', `折叠提案 ${id}`, [id], {
          id,
          detail: record.reason ?? (record.appliedSeq ? `appliedSeq: ${record.appliedSeq}` : null),
        })
      }
      if (record.op === 'apply-late') {
        return base(at, 'fold.apply-late', 'ink', `折叠提案 ${id} 补记替换`, [id], {
          id,
          detail: record.reason ?? (record.appliedSeq ? `appliedSeq: ${record.appliedSeq}` : null),
        })
      }
      return null
    }
    default:
      return null
  }
}

/**
 * 收集一个会话的全量流水行（含工作区共享事实的操作行）。
 * 每次现读磁盘上的 JSONL：append-only，读文件就是读真相，不做缓存（错缓存比慢更糟）。
 */
export function collectAuditRows(dir, sharedPath = null) {
  const rows = []
  let seq = 0
  for (const log of AUDIT_LOGS) {
    let path
    try {
      path = join(dir, `${log}.jsonl`)
      statSync(path)
    } catch {
      continue
    }
    const records = readLog(path)
    const index = buildIndex(log, records)
    for (const record of records) {
      const row = mapRecord(log, record, index)
      if (row !== null) rows.push({ ...row, seq: (seq += 1) })
    }
  }
  if (typeof sharedPath === 'string' && sharedPath !== '') {
    const records = (() => {
      try {
        statSync(sharedPath)
        return readLog(sharedPath)
      } catch {
        return []
      }
    })()
    const index = buildIndex('facts', records)
    for (const record of records) {
      const row = mapRecord('facts', record, index, { sharedScope: true })
      if (row !== null) rows.push({ ...row, seq: (seq += 1) })
    }
  }
  rows.sort((a, b) => b.at - a.at || b.seq - a.seq)
  return rows
}

/** day 模式下找「下一个有数据的日子」：小于给定 day 的最大 day（过 kind/branch 滤网）。 */
function previousDayWithRows(rows, { day, kind, branch }) {
  for (const row of rows) {
    if (row.day >= day) continue
    if (kind !== null && row.kind !== kind) continue
    if (branch !== null && row.branch !== branch) continue
    return row.day
  }
  return null
}

/**
 * 全量流水的按天分页。rows 已按 (at, seq) 新者在前。
 *  - day 模式（给了 day）：只出该天的行；当天翻不完 → nextCursor 带回 before 续翻当天；
 *    当天翻完 → nextCursor = { day: 下一个有数据的日子 }。
 *  - 游标模式（不给 day）：从头开始，nextCursor = { before, beforeSeq, day }，
 *    (at, seq) 字典序排除了同毫秒并列时的漏行/重行——无缺口从最新翻到最早。
 */
export function auditPage(rows, input = {}) {
  const limitRaw = Number(input.limit ?? AUDIT_PAGE_DEFAULT)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), AUDIT_PAGE_MAX) : AUDIT_PAGE_DEFAULT
  const kind = input.kind === undefined || input.kind === null ? null : String(input.kind)
  const branch = input.branch === undefined || input.branch === null ? null : String(input.branch)
  const day = Number.isInteger(input.day) ? input.day : null
  const before = Number.isFinite(input.before) ? input.before : null
  const beforeSeq = Number.isInteger(input.beforeSeq) ? input.beforeSeq : null

  const filtered = rows.filter((row) => {
    if (day !== null && row.day !== day) return false
    if (kind !== null && row.kind !== kind) return false
    if (branch !== null && row.branch !== branch) return false
    if (before !== null) {
      if (row.at > before) return false
      if (row.at === before && beforeSeq !== null && row.seq >= beforeSeq) return false
    }
    return true
  })

  const page = filtered.slice(0, limit)
  const last = page[page.length - 1]
  let nextCursor = null
  if (day !== null) {
    if (filtered.length > limit) {
      // 当天还有：给同日续翻游标。
      nextCursor = { day, before: last.at, beforeSeq: last.seq }
    } else {
      const previous = previousDayWithRows(rows, { day, kind, branch })
      nextCursor = previous === null ? null : { day: previous }
    }
  } else if (filtered.length > limit) {
    const upcoming = filtered[limit]
    nextCursor = { before: last.at, beforeSeq: last.seq, day: upcoming.day }
  }

  return {
    rows: page.map(({ seq, ...row }) => row),
    nextCursor,
  }
}
