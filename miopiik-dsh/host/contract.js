/**
 * 派发契约 —— SPEC §4.1 / §4.4。
 *
 * 契约 = 交付物 + 验收标准 + 验收样例 + 边界 + 预算（外加 Mind 的一句话目标复述）。
 * 缺任何一项就只配草稿，不配正式派发；错误信息要给出缺失清单，而不是一句"参数不对"。
 * 准确性在派发时决定，不在 commit 时检验。
 */

export const CONTRACT_FIELDS = Object.freeze([
  ['goal', '一句话复述目标'],
  ['deliverables', '交付物'],
  ['acceptance', '验收标准'],
  ['acceptanceSample', '验收样例（大概长这样）'],
  ['boundary', '边界（不许改什么）'],
  ['budget', '预算'],
])

/** 返回 { ok, missing } —— missing 是中文缺失清单，直接给 Mind 看。 */
export function validateContract(input) {
  const missing = CONTRACT_FIELDS.filter(([key]) => {
    const value = input?.[key]
    return typeof value !== 'string' || value.trim() === ''
  }).map(([, label]) => label)
  return { ok: missing.length === 0, missing }
}

/** 把契约渲染成给 Operator 的派发提示。Operator 只认契约，看不到对话。 */
export function renderContractPrompt(contract) {
  return [
    'You are an Operator working in the background. You never talk to the user.',
    'You get a contract and nothing else. Your job is to satisfy it and report back.',
    '',
    `## Goal (one sentence, as the conversation restated it)\n${contract.goal}`,
    '',
    `## Deliverables\n${contract.deliverables}`,
    '',
    `## Acceptance criteria\n${contract.acceptance}`,
    '',
    `## Acceptance sample (what "good" roughly looks like)\n${contract.acceptanceSample}`,
    '',
    `## Boundary (do not change these)\n${contract.boundary}`,
    '',
    `## Budget\n${contract.budget}`,
    '',
    '## Rules',
    '- Start by producing the cheapest early shape (outline / plan / first screen) so it can be checked early.',
    '- Do not ask the user anything. If the contract is ambiguous, pick the reading the sample supports and say so in your final report.',
    '- If you need a fact the contract does not state, call ink_ask. It answers only by citation; if it escalates, proceed on your best reading and note the assumption.',
    '- Your final message is the deliverable report: what you produced, where it is, how it meets each acceptance criterion, and what remains uncertain.',
  ].join('\n')
}
