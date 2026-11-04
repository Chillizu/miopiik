/**
 * 鱼骨：分支节点 —— SPEC §1.3 / §4.6。
 *
 * 主干是对话；分支从**对话的某个节点**分叉出来（记下当时的 turn 与序号），
 * 可以承载任意多个 Operator 任务，最后把结论汇回主干（merge → note → 收件箱）。
 *
 * 分支不是任务：任务是「谁在干」，分支是「这件事从对话哪一句长出来的」。
 * 一个分支可以有多个任务，也可以在没有任何任务时只作为一个思考支线存在。
 */

export const BRANCH_STATUSES = Object.freeze(['open', 'merged', 'abandoned'])

export function makeBranch(input) {
  const at = input.at ?? Date.now()
  return {
    id: input.id,
    label: String(input.label ?? '').trim(),
    /** 从主干的哪一轮、哪一句分叉出来的（对话节点指针）。 */
    forkedAtTurn: input.forkedAtTurn ?? null,
    forkedAtSeq: input.forkedAtSeq ?? null,
    forkedFrom: input.forkedFrom ?? 'trunk',
    /** 一句话说这个分支在追什么；由 Mind 写，可更新（不覆盖历史）。 */
    summary: String(input.summary ?? '').trim(),
    status: 'open',
    jobs: [],
    createdAt: at,
    updatedAt: at,
    settledAt: null,
    mergedInto: null,
  }
}

/** 主干 + 分支的一览（L3 用）：只给标签、一句话、任务计数、状态。 */
export function describeBranches(branches, jobs, { max = 4 } = {}) {
  const open = branches.filter((branch) => branch.status === 'open')
  if (open.length === 0) return []
  return open.slice(0, max).map((branch) => {
    const own = jobs.filter((job) => job.branchId === branch.id)
    const running = own.filter((job) => job.state === 'running').length
    const done = own.filter((job) => job.state === 'done').length
    const counts = own.length === 0 ? '还没有任务' : `${own.length} 个任务（${done} 完成 / ${running} 在跑）`
    const fork = branch.forkedAtTurn === null ? '' : `，从第 ${branch.forkedAtTurn} 轮分叉`
    return `${branch.id} ${branch.label}：${branch.summary || '（还没写一句话）'}（${counts}${fork}）`
  })
}
