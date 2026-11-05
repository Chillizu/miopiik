/**
 * 任务板 —— **中间层的职责**（SPEC §3，用户在 seq 254 明确：任务板由中间层设定并分配给 O）。
 *
 * 分工：
 *  - Ink 开卡（含契约）、判定收口（完成 / 判废）；
 *  - O 只执行与回报，不定义任务；
 *  - M 只表达意图，不碰任务板。
 *
 * 任务板是 DSH 的 agentTeams 共享 board（智能体团队可见）。没有会籍（非 Lead）时静默跳过，
 * 任务板是可见性通道，不是依赖。
 */

/** 开卡：Ink 把一份契约写成一张卡。 */
export async function openCard(ctx, agent, { jobId, contract }) {
  try {
    const teams = ctx.get('agentTeams')
    if (teams === undefined || typeof teams.tryMembership !== 'function') return null
    if (teams.tryMembership(agent) === undefined) return null
    const description = [
      contract.goal,
      contract.deliverables ? `交付：${contract.deliverables}` : null,
      contract.acceptance ? `验收：${contract.acceptance}` : null,
      contract.acceptanceSample ? `验收样例：${contract.acceptanceSample}` : null,
      contract.boundary ? `边界：${contract.boundary}` : null,
      contract.budget ? `预算：${contract.budget}` : null,
    ]
      .filter((line) => line !== null)
      .join('\n')
    const view = await teams.createTask(agent, {
      subject: `O-${jobId} ${contract.goal}`.slice(0, 80),
      description,
    })
    return { id: view.id, description }
  } catch {
    return null
  }
}

/** 收口：任务板要求「先认领才能完成」，每次操作都要最新版本号。 */
export async function settleCard(ctx, agent, card, note) {
  if (card === null || card === undefined) return
  try {
    const teams = ctx.get('agentTeams')
    const ready = teams.getTask(agent, card.id)
    const claimed = await teams.updateTask(agent, {
      taskId: card.id,
      expectedRevision: ready.revision,
      action: 'claim',
    })
    await teams.updateTask(agent, {
      taskId: card.id,
      expectedRevision: claimed.revision,
      action: 'complete',
      description: `${ready.description ?? ''}\n\n结果：${note}`,
    })
  } catch {
    // 任务板失败不影响任务本身
  }
}
