/**
 * 开环（open loop）—— SPEC §4.3。
 *
 * 开环不是待办：没有日期、没有 owner、没有状态机。
 * 一条 = 一句话 + 指针 + 闭合条件。
 * 生命周期：登记 → 老化（2 天休眠 / 7 天折成一行，不删）→ 命中复活 → 闭合。
 * 闭合权只在 Mind；本模块只提供纯函数，不做任何判断以外的副作用。
 */

/** 六型（SPEC §4.3）。 */
export const LOOP_TYPES = Object.freeze([
  'unanswered-question',
  'awaiting-user',
  'pending-option',
  'promise',
  'pending-dispatch',
  'forming-intent',
])

/** 活跃开环进入上下文的上限（SPEC §4.3：约 12）。休眠不设限。 */
import { DEFAULTS } from './config-defaults.js'

export const ACTIVE_LOOP_CAP = DEFAULTS.activeLoopCap

/** 隔多少天休眠 / 折成一行（SPEC §5.6）。 */
export const DORMANT_AFTER_DAYS = DEFAULTS.dormantAfterDays
export const FOLDED_AFTER_DAYS = DEFAULTS.foldedAfterDays

const DAY_MS = 24 * 60 * 60 * 1000

/** 一天的整数序号，用于天轴老化。 */
export function dayOf(timestamp) {
  return Math.floor(timestamp / DAY_MS)
}

/** 造一条新开环（未落盘，交给 store）。 */
export function makeLoop(input) {
  const at = input.at ?? Date.now()
  return {
    id: input.id,
    text: String(input.text ?? '').trim(),
    type: input.type,
    pointer: input.pointer ?? null,
    closureCondition: input.closureCondition ?? null,
    status: 'active',
    turn: input.turn ?? null,
    epoch: input.epoch ?? 0,
    createdAt: at,
    lastTouchedAt: at,
    lastTouchedDay: dayOf(at),
    closedAt: null,
    closedBy: null,
  }
}

/** 按天轴与 epoch 计算一条开环应有的状态（纯函数，不改原对象）。 */
export function statusOf(loop, { today, epoch }) {
  if (loop.status === 'closed' || loop.status === 'dropped') return loop.status
  if (today - loop.lastTouchedDay >= FOLDED_AFTER_DAYS) return 'folded'
  if (today - loop.lastTouchedDay >= DORMANT_AFTER_DAYS) return 'dormant'
  return 'active'
}

/** 老化计算：返回需要改写状态的 [id, status] 列表（固定顺序，不让模型裁量）。 */
export function ageLoops(loops, { today, epoch }) {
  const changes = []
  for (const loop of loops) {
    if (loop.status === 'closed' || loop.status === 'dropped') continue
    const next = statusOf(loop, { today, epoch })
    if (next !== loop.status) changes.push([loop.id, next])
  }
  return changes
}

/**
 * 超过活跃上限时的折叠顺序（SPEC §4.3）：最近没命中的先折，再按创建时间最老的先折。
 * 返回需要降为休眠的 id 列表；不删任何东西。
 */
export function overflowToDormant(loops, cap = ACTIVE_LOOP_CAP) {
  const active = loops.filter((loop) => loop.status === 'active')
  if (active.length <= cap) return []
  const ordered = [...active].sort((a, b) => {
    if (b.lastTouchedAt !== a.lastTouchedAt) return b.lastTouchedAt - a.lastTouchedAt
    return b.createdAt - a.createdAt
  })
  // 溢出集合内部也按「最该先折的在前」排列：最近没命中的排最前。
  return ordered
    .slice(cap)
    .reverse()
    .map((loop) => loop.id)
}

/** 活跃开环（按最近触碰排序，供 L3 与工具使用）。 */
export function activeLoops(loops) {
  return loops
    .filter((loop) => loop.status === 'active')
    .sort((a, b) => b.lastTouchedAt - a.lastTouchedAt)
}

/** 一条开环改写成疑问句 —— 预览结尾那个问题的来源（SPEC §3.3）。 */
export function asQuestion(loop) {
  const text = loop.text.trim().replace(/[。.!！?？]+$/u, '')
  if (/^(要不要|是否|是不是|该不该)/u.test(text)) return `${text}？`
  return `${text}——要不要现在接着聊？`
}
