/**
 * 后台流水的全量取数通道 —— SPEC §2.2「账本是数据」。
 *
 * 与 snapshot.audit 的尾部采样不同：这里直接读会话目录的 JSONL 原始日志
 * （append-only，回放即真相），把每一条可重建操作的记录映射成统一行形状，
 * 按 (at, seq) 新者在前排序，供 auditPage 按天/游标翻页。
 *
 * 纯函数模块：不碰 Engine 状态、不写文件；Engine 只是提供目录与分页入参。
 * collectMindRows（SPEC §13.10）同读这些账本，筛 Mind 署名的动作行给鱼骨 Mind 泳道。
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

// ── Mind 事件流（SPEC §13.10）：与流水同一本账本、同一套「只认可判定字段」纪律 ──

/**
 * mind 事件流的参与日志：流水十本里去掉 notes 与 observations（全数 Ink 署名），
 * 其余八本 + 工作区共享事实账本按 §13.10 的口径筛 Mind 手笔。
 */
const MIND_LOGS = Object.freeze(['branches', 'loops', 'inbox', 'jobs', 'facts', 'drafts', 'briefings', 'folds'])

/** mind 事件流单载荷截窗：与 snapshot.audit.notes 同量级，防载荷爆炸。 */
export const MIND_EVENTS_MAX = 40

/** 行形状 { id, at, kind, label, refs }：id 是账本对象 id（点击走流水溯源的既有通道）。
 *  label 只从记录里真正可判定的字段拼出来；拼不出（如缺对象 id）就退回 kind 原文，不凭空造。
 */
function mindRow(at, kind, id, label, refs) {
  if (!Number.isFinite(at)) return null
  const row = { id: String(id ?? ''), at, kind, label: String(label ?? ''), refs: Array.isArray(refs) ? refs.map(String) : [] }
  if (row.label === '') row.label = kind
  return row
}

/** 派发记账开环的判定形状：operator.js 派发时写的 pending-dispatch + J-* 指针（Operator 署名，不进 mind 流）。 */
const DISPATCH_LOOP_POINTER = /^J-\d+$/u

/**
 * 单条记录 → mind 行；判不出是 Mind 手笔就返回 null（宁可漏进流水，不凭空署名）。
 * 口径（SPEC §13.10，与 audit.js 同源账本、同判定纪律）：
 *  - 只经 Mind 窄工具面可产生的 op 全收（ink_branch/ink_dispatch/ink_loops/ink_inbox/ink_facts/ink_draft/ink_brief）；
 *  - 需要记录里真有判定字段的 op 只认字段：loop.close/drop 只认 by==='mind'，
 *    fact.add 只认 source==='user'（ink_report 写 operator、编译回灌写 ink，都不冒领），
 *    draft.add 只认 source!=='operator'、draft.settle 只认 status!=='expired'（过期是 Ink 的老化），
 *    fold.apply/reject 只认 by==='mind'；
 *  - loop.add 是 Mind 登记开环的手笔，但派发记账（pending-dispatch + J-* 指针）可判定为 Operator，剔除。
 */
function mapMindRecord(log, record) {
  if (record === null || typeof record !== 'object') return null
  switch (log) {
    case 'branches': {
      if (record.op === 'create') {
        const branch = record.branch ?? {}
        if (typeof branch.id !== 'string' || branch.id === '') return null
        return mindRow(Number.isFinite(branch.createdAt) ? branch.createdAt : record.at, 'branch.fork', branch.id, `开线 ${branch.id}`, [branch.id])
      }
      const id = typeof record.branchId === 'string' && record.branchId !== '' ? record.branchId : null
      if (id === null) return null
      if (record.op === 'summary') return mindRow(record.at, 'branch.summary', id, `补摘要 ${id}`, [id])
      if (record.op === 'context') return mindRow(record.at, 'branch.context', id, `补上下文 ${id}`, [id])
      if (record.op === 'merge') {
        return mindRow(record.at, 'branch.merge', id, `并回 ${id}`, [id, record.mergedInto].filter(Boolean))
      }
      if (record.op === 'abandon') return mindRow(record.at, 'branch.abandon', id, `放弃 ${id}`, [id])
      return null // attach-job 是 Ink 的机械挂接，不署 Mind。
    }
    case 'loops': {
      if (record.op === 'create') {
        const loop = record.loop ?? {}
        if (typeof loop.id !== 'string' || loop.id === '') return null
        if (loop.type === 'pending-dispatch' && DISPATCH_LOOP_POINTER.test(String(loop.pointer ?? ''))) return null
        const at = Number.isFinite(loop.createdAt) ? loop.createdAt : record.at
        return mindRow(at, 'loop.add', loop.id, `开环 ${loop.id}`, [loop.id])
      }
      if (record.op !== 'close' && record.op !== 'drop') return null
      if (record.by !== 'mind') return null // by==='ink'（草稿收尾）与 by==='user'（界面干预）都不冒领。
      const id = typeof record.loopId === 'string' && record.loopId !== '' ? record.loopId : null
      if (id === null) return mindRow(record.at, `loop.${record.op}`, '', '', [])
      return mindRow(record.at, `loop.${record.op}`, id, record.op === 'close' ? `闭合 ${id}` : `丢弃 ${id}`, [id])
    }
    case 'inbox': {
      const ops = { read: '读收件箱', star: '标星', unstar: '取消星标', defer: '缓读' }
      if (ops[record.op] === undefined) return null // deliver/supersede 是 Ink 的投递与顶替。
      const id = typeof record.itemId === 'string' && record.itemId !== '' ? record.itemId : null
      if (id === null) return mindRow(record.at, `inbox.${record.op}`, '', '', [])
      return mindRow(record.at, `inbox.${record.op}`, id, `${ops[record.op]} ${id}`, [id])
    }
    case 'jobs': {
      if (record.op !== 'create') return null // update 是执行层的状态落账。
      const job = record.job ?? {}
      if (typeof job.id !== 'string' || job.id === '') return null
      const at = Number.isFinite(job.createdAt) ? job.createdAt : record.at
      return mindRow(at, 'job.dispatch', job.id, `派发 ${job.id}`, [job.id, job.loopId].filter(Boolean))
    }
    case 'facts': {
      if (record.op === 'add') {
        const fact = record.fact ?? {}
        if (fact.source !== 'user') return null // ink_report 写 operator、编译回灌写 ink：字段判不出是 Mind 手笔就不收。
        if (typeof fact.id !== 'string' || fact.id === '') return null
        const at = Number.isFinite(fact.createdAt) ? fact.createdAt : record.at
        return mindRow(at, 'fact.add', fact.id, `立事实 ${fact.id}`, [fact.id])
      }
      if (record.op === 'revise') {
        const id = typeof record.factId === 'string' && record.factId !== '' ? record.factId : null
        if (id === null) return mindRow(record.at, 'fact.revise', '', '', [])
        return mindRow(record.at, 'fact.revise', id, `修订 ${id}`, [id])
      }
      return null // invalidate 是用户干预或 Ink 的失效动作。
    }
    case 'drafts': {
      if (record.op === 'create') {
        const draft = record.draft ?? {}
        if ((draft.source ?? 'mind') === 'operator') return null // Operator 草稿态结果的落账。
        if (typeof draft.id !== 'string' || draft.id === '') return null
        const at = Number.isFinite(draft.createdAt) ? draft.createdAt : record.at
        return mindRow(at, 'draft.add', draft.id, `落草稿 ${draft.id}`, [draft.id])
      }
      if (record.op === 'update') {
        const patch = record.patch ?? {}
        if (typeof patch.status !== 'string' || patch.status === 'expired') return null // 过期是 Ink 的七天老化。
        const id = typeof record.draftId === 'string' && record.draftId !== '' ? record.draftId : null
        if (id === null) return mindRow(record.at, 'draft.settle', '', '', [])
        return mindRow(record.at, 'draft.settle', id, `了草稿 ${id}（${patch.status}）`, [id])
      }
      return null
    }
    case 'briefings': {
      const at = Number.isFinite(record.at) ? record.at : null
      if (record.kind === undefined || record.kind === null) {
        if (at === null) return null
        return mindRow(
          at,
          'briefing',
          Number.isFinite(record.day) ? `briefing-${record.day}-${at}` : `briefing-${at}`,
          Number.isFinite(record.day) ? `写交接简报（第 ${record.day} 天）` : 'briefing',
          [],
        )
      }
      if (record.kind === 'overnight') {
        if (at === null) return null
        return mindRow(at, 'briefing.overnight', `briefing-${at}`, '补隔夜更新', [])
      }
      return null // auto-materials / closing-signal / hard-break 是 Ink 整理的盘外素材。
    }
    case 'folds': {
      if (record.op !== 'apply' && record.op !== 'reject') return null // propose/apply-late 是 Ink 的。
      if (record.by !== 'mind') return null
      const id = typeof record.foldId === 'string' && record.foldId !== '' ? record.foldId : null
      if (id === null) return mindRow(record.at, `fold.${record.op}`, '', '', [])
      return mindRow(record.at, `fold.${record.op}`, id, record.op === 'apply' ? `落折叠 ${id}` : `驳回折叠 ${id}`, [id])
    }
    default:
      return null
  }
}

/**
 * 收集一个会话的 Mind 事件流（含工作区共享事实账本里可判定的 Mind 行）。
 * 与 collectAuditRows 同一读法：每次现读磁盘 JSONL，坏行跳过，不做缓存；
 * 升序排（旧→新），只留最近 MIND_EVENTS_MAX 条防载荷爆炸。
 */
export function collectMindRows(dir, sharedPath = null) {
  const rows = []
  let seq = 0
  for (const log of MIND_LOGS) {
    let path
    try {
      path = join(dir, `${log}.jsonl`)
      statSync(path)
    } catch {
      continue
    }
    for (const record of readLog(path)) {
      const row = mapMindRecord(log, record)
      if (row !== null) rows.push({ ...row, seq: (seq += 1) })
    }
  }
  if (typeof sharedPath === 'string' && sharedPath !== '') {
    let records = []
    try {
      statSync(sharedPath)
      records = readLog(sharedPath)
    } catch {
      records = []
    }
    for (const record of records) {
      const row = mapMindRecord('facts', record)
      if (row !== null) rows.push({ ...row, seq: (seq += 1) })
    }
  }
  rows.sort((a, b) => a.at - b.at || a.seq - b.seq)
  return rows.slice(-MIND_EVENTS_MAX).map(({ seq, ...row }) => row)
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
