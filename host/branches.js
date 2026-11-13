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
    /**
     * 分支自己的上下文切片（SPEC §2.4b）。
     * 分支要能独立推进，就必须带着「它从哪句话长出来的」+「它依赖哪些已定事实」，
     * 而不是每次回头翻整个主干。
     */
    context: {
      /** 分叉处的前提：为什么开这条分支、当时的语境（Mind 用自己的话写）。 */
      premise: String(input.premise ?? '').trim(),
      /** 从主干原文里摘出的关键句（引用，不改写）。 */
      quotes: [],
      /** 这条分支依赖的事实卡 id。 */
      facts: [],
    },
    status: 'open',
    jobs: [],
    createdAt: at,
    updatedAt: at,
    settledAt: null,
    mergedInto: null,
  }
}

/** 把一条分支的切片组装成给 Operator / Mind 看的文本（空的部分不出现）。 */
export function renderBranchSlice(branch, facts) {
  const lines = [`## 分支 ${branch.id}：${branch.label}`]
  if (branch.summary) lines.push(`在追什么：${branch.summary}`)
  const fork = branch.forkedAtTurn === null ? '' : `（从第 ${branch.forkedAtTurn} 轮分叉）`
  const context = branch.context ?? { premise: '', quotes: [], facts: [] }
  if (context.premise) lines.push(`前提${fork}：${context.premise}`)
  else if (fork !== '') lines.push(`前提${fork}：（还没写）`)
  if (context.quotes.length > 0) {
    lines.push('主干原文（引用，不要改写）：')
    for (const quote of context.quotes) lines.push(`> ${quote}`)
  }
  if (context.facts.length > 0) {
    lines.push('已定事实（按 id 引用，不要重新推导）：')
    for (const id of context.facts) {
      const fact = facts.get(id)
      lines.push(fact === undefined ? `- [${id}]（事实卡不存在）` : `- [${id}] ${fact.claim}`)
    }
  }
  return lines.join('\n')
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
