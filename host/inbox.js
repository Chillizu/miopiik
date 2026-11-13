/**
 * 收件箱 —— SPEC §3.3。
 *
 * 分层视图（不是加权公式）：T0 阻塞 / T1 命中活跃开环 / T2 新结论 / T3 其余。
 * 硬规则：每条预览必须带开环指针（指不上降 T3）；同一开环最多一条待读（后来的合并更新）；
 * epoch 不匹配标 stale 降一级；每轮最多 3 条完整预览 + 一行计数。
 * 默认视图不是硬管：调用方可以要全量。
 */

export const TIER = Object.freeze({ T0: 0, T1: 1, T2: 2, T3: 3 })
import { DEFAULTS } from './config-defaults.js'

export const PREVIEW_CHAR_BUDGET = DEFAULTS.inboxPreviewChars
const TIER_NAMES = ['T0', 'T1', 'T2', 'T3']

/** 待读状态（已读/星标不算待读，但仍在三区里可见）。 */
export const PENDING_STATUSES = Object.freeze(['unread', 'deferred'])

/** 一条收件箱条目的基础形状（未落盘）。 */
export function makeItem(input) {
  const at = input.at ?? input.createdAt ?? Date.now()
  return {
    id: input.id,
    noteId: input.noteId ?? null,
    loopId: input.loopId ?? null,
    branchId: input.branchId ?? null,
    blocking: input.blocking === true,
    newConclusion: input.newConclusion === true,
    epoch: input.epoch ?? 0,
    status: input.status ?? 'unread',
    claim: String(input.claim ?? ''),
    question: input.question ?? null,
    createdAt: at,
  }
}

/** 计算一条条目的当前层级（纯函数）。 */
export function tierOf(item, { currentEpoch, activeLoopIds }) {
  let tier
  if (item.blocking) tier = TIER.T0
  else if (item.loopId !== null && activeLoopIds.has(item.loopId)) tier = TIER.T1
  else if (item.branchId !== null) tier = TIER.T1 // 鱼骨分支也是「连着对话节点」，同样算相关
  else if (item.newConclusion) tier = TIER.T2
  else tier = TIER.T3
  // 指不上任何对话节点的预览不能占最前面（相关性就是结构）。
  if (tier === TIER.T1 && item.loopId === null && item.branchId === null) tier = TIER.T3
  // 过期不等于作废：降一级，不逐级叠降。
  if (item.epoch !== currentEpoch && tier < TIER.T3) tier += 1
  return tier
}

export function tierName(tier) {
  return TIER_NAMES[tier] ?? 'T3'
}

/**
 * 同一开环最多一条待读：保留最新的待读条目，其余标记 superseded（合并更新）。
 * 返回需要标 superseded 的 id 列表。
 */
export function mergeByLoop(items) {
  const best = new Map()
  const superseded = []
  for (const item of items) {
    if (!PENDING_STATUSES.includes(item.status)) continue
    const key = item.loopId ?? (item.branchId === null ? null : `branch:${item.branchId}`)
    if (key === null) continue
    const kept = best.get(key)
    if (kept === undefined) {
      best.set(key, item)
      continue
    }
    if (item.createdAt >= kept.createdAt) {
      superseded.push(kept.id)
      best.set(key, item)
    } else {
      superseded.push(item.id)
    }
  }
  return superseded
}

/**
 * 组装这一轮 Mind 看到的视图。
 * @returns {{ previews: Array, hiddenCount: number, byTier: Record<string, number> }}
 */
export function selectView(items, { currentEpoch, activeLoopIds, budget = PREVIEW_CHAR_BUDGET, all = false }) {
  const live = items.filter((item) => item.status !== 'superseded')
  const pending = live
    .filter((item) => PENDING_STATUSES.includes(item.status))
    .map((item) => ({ item, tier: tierOf(item, { currentEpoch, activeLoopIds }) }))
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier
      return b.item.createdAt - a.item.createdAt
    })
  // 不数条数，数字：能塞几条塞几条，至少给一条（「能挤就挤」，但挤不下本身就是信号）。
  const shown = []
  if (all) shown.push(...pending)
  else {
    let used = 0
    for (const entry of pending) {
      const cost = `${entry.item.claim ?? ''}${entry.item.question ?? ''}`.length + 8
      if (shown.length > 0 && used + cost > budget) break
      shown.push(entry)
      used += cost
    }
  }
  return {
    previews: shown,
    hiddenCount: Math.max(0, pending.length - shown.length),
    byTier: pending.reduce((acc, entry) => {
      const name = tierName(entry.tier)
      acc[name] = (acc[name] ?? 0) + 1
      return acc
    }, {}),
  }
}
