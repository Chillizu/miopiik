/**
 * 叙事折叠的两阶段 —— SPEC §5.1。
 *
 * 折叠不是「把历史摘要掉」，而是「叙事折叠 + 开环结算」，并且必须两阶段：
 *   1. Ink 先做**影子折叠**（proposal）：档案 + 开环结算 + 事实增量，先不替换；
 *   2. **仍持有旧上下文的 Mind 验收**：接得上就通过（可以自己改写档案），接不上就退回重折；
 *   3. 通过后才原子替换（交给 DSH 的 compaction；拿不到就只记账，绝不偷偷改上下文）。
 *
 * 关键不变式：验收判据是「每条开环都还接得上」，不是「摘要看起来不错」。
 */

export const FOLD_STATUSES = Object.freeze(['pending', 'applied', 'rejected'])

/** 机械档案：只从观测日志取「用户说的」与「助手最终说的」，不推演。 */
export function buildArchive(observations, { maxItems = 40, maxChars = 1200 } = {}) {
  const lines = []
  for (const entry of observations) {
    if (entry.kind !== 'user' && entry.kind !== 'assistant') continue
    const text = String(entry.text ?? '').replace(/\s+/gu, ' ').trim()
    if (text === '') continue
    const speaker = entry.kind === 'user' ? '用户' : '我'
    lines.push(`${speaker}：${text.slice(0, 90)}`)
  }
  const kept = lines.slice(-maxItems)
  let archive = kept.join('\n')
  if (archive.length > maxChars) archive = `${archive.slice(0, maxChars)}…`
  return { archive, covered: kept.length, total: lines.length }
}

/** 开环结算建议（不改状态，只给 Mind 看）：哪些看起来闭合了、哪些还活着。 */
export function settlementDraft(loops) {
  const active = loops.filter((loop) => loop.status === 'active')
  return active.map((loop) => ({
    id: loop.id,
    text: loop.text,
    suggestion: loop.lastTouchedDay < 0 ? 'dormant' : 'keep',
  }))
}

/** 组装一份折叠提案。 */
export function makeProposal(input) {
  const at = input.at ?? Date.now()
  return {
    id: input.id,
    day: input.day,
    epoch: input.epoch ?? 0,
    archive: String(input.archive ?? ''),
    covered: input.covered ?? 0,
    total: input.total ?? 0,
    settlements: Array.isArray(input.settlements) ? input.settlements : [],
    status: 'pending',
    createdAt: at,
    settledAt: null,
    settledBy: null,
    appliedSeq: null,
  }
}

/**
 * 验收判据：折叠之后，每条仍然活跃的开环都还得「接得上」。
 * 返回不通过的理由（空数组 = 通过）。
 */
export function verifyProposal(proposal, { loops, minArchiveChars = 12 } = {}) {
  const problems = []
  const archive = String(proposal.archive ?? '')
  if (archive.trim().length < minArchiveChars) {
    problems.push(`档案太短（${archive.trim().length} 字），折完会接不上`)
  }
  const active = loops.filter((loop) => loop.status === 'active')
  for (const loop of active) {
    // 结算建议不算落点：只有档案里真写到它，或者 Mind 先把它闭合/显式改写，
    // 才算「折叠之后还接得上」。
    const mentioned =
      archive.includes(loop.text) ||
      archive.includes(loop.id) ||
      (loop.closureCondition !== null && archive.includes(loop.closureCondition))
    if (!mentioned) problems.push(`开环 ${loop.id}「${loop.text}」在折叠后找不到落点（要么写进档案，要么先闭合它）`)
  }
  return problems
}
