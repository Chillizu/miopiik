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

/**
 * 草稿态派发（SPEC §4.4）：不需要六要素齐全——因为产出可丢弃。
 * 只要有一个目标就能跑；缺的部分由 Operator 按最保守读法补，并在报告里说明。
 */
export function validateDraft(input) {
  const goal = typeof input?.goal === 'string' ? input.goal.trim() : ''
  return goal === '' ? { ok: false, missing: ['一句话目标'] } : { ok: true, missing: [] }
}

/** 草稿态提示：明确告诉 Operator「这是探索，不是交付」。 */
export function renderDraftPrompt(input) {
  return [
    'You are an Operator doing an exploratory pass in the background. You never talk to the user.',
    'This is a DRAFT: it will not be shown to the user unless someone later promotes it.',
    '',
    `## What to explore\n${String(input?.goal ?? '').trim()}`,
    '',
    '## Rules',
    '- Produce the cheapest useful artifact: a sketch, a list, a few candidate answers — not a finished deliverable.',
    '- State every assumption you had to make, in one line each.',
    '- Do not ask the user anything and do not dispatch further work.',
    '- Your final message is a short draft report: what you found, what you assumed, what is still open.',
  ].join('\n')
}

/**
 * 把契约渲染成给 Operator 的派发提示。
 * Operator 看不到对话；它能看到的是契约 + 它所属分支的上下文切片（如果有）。
 */
export function renderContractPrompt(contract, branchSlice = null) {
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
    ...(branchSlice === null ? [] : [branchSlice, '']),
    '## Rules',
    '- Start by producing the cheapest early shape (outline / plan / first screen) so it can be checked early.',
    '- Do not ask the user anything. If the contract is ambiguous, pick the reading the sample supports and say so in your final report.',
    '- If you need a fact the contract does not state, call ink_ask. It answers only by citation; if it escalates, proceed on your best reading and note the assumption.',
    '- Your final message is the deliverable report: what you produced, where it is, how it meets each acceptance criterion, and what remains uncertain.',
    '- If you settled a conclusion that should change future judgment, hand it back with ink_report (claim + evidence). One or two at most; it is a ledger, not a notepad.',
  ].join('\n')
}
