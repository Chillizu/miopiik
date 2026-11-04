/**
 * 决定账（note）—— SPEC §2.2 / §3.1。
 *
 * note 是状态增量，不是日记：变了什么、证据指针、置信、牵动哪条开环。
 * 必填 claim + why；refs 除 absorb 外必填；kind 决定其余字段。
 * hash 只能取回不能检索 —— 本模块只校验与造记录，检索索引在 store/engine 侧。
 */

export const NOTE_KINDS = Object.freeze([
  'absorb',
  'preview',
  'answer',
  'ask',
  'hold',
  'verify',
  'fold',
  'escalate',
  'drop',
])

/** 造一条 note（未落盘）。 */
export function makeNote(input) {
  return {
    id: input.id,
    kind: input.kind,
    claim: String(input.claim ?? '').trim(),
    why: String(input.why ?? '').trim(),
    refs: Array.isArray(input.refs) ? input.refs.map(String) : [],
    loops: Array.isArray(input.loops) ? input.loops.map(String) : [],
    conf: input.conf ?? 'mid',
    question: input.question ?? null,
    detail: input.detail ?? null,
    visibleToUser: input.visibleToUser === true,
    newConclusion: input.newConclusion === true,
    contradiction: input.contradiction ?? null,
    staleAfter: input.staleAfter ?? null,
    supersedes: input.supersedes ?? null,
    epoch: input.epoch ?? 0,
    at: input.at ?? Date.now(),
  }
}

/**
 * 校验一条 note 是否成立。返回错误清单；空数组 = 合法。
 * 判据是出口格式，不是思考过程：可以想得很自由，但出口必须有证据。
 */
export function validateNote(note) {
  const errors = []
  if (typeof note !== 'object' || note === null) return ['note 不是对象']
  if (!NOTE_KINDS.includes(note.kind)) errors.push(`未知 kind: ${note.kind}`)
  if (typeof note.claim !== 'string' || note.claim.trim() === '') errors.push('缺少 claim')
  if (typeof note.why !== 'string' || note.why.trim() === '') errors.push('缺少 why')
  if (!Array.isArray(note.refs)) errors.push('refs 必须是数组')
  // 只有「自答类」必须带引用；上报（hold/escalate/ask）与 absorb 可以没有。
  else if (['answer', 'verify', 'preview', 'fold'].includes(note.kind) && note.refs.length === 0) {
    errors.push(`${note.kind} 必须带 refs`)
  }
  if (note.kind === 'preview') {
    if (!Array.isArray(note.loops) || note.loops.length === 0) errors.push('preview 必须带开环指针')
    if (typeof note.question !== 'string' || note.question.trim() === '') errors.push('preview 必须以一个问题结尾')
  }
  if (note.kind === 'verify' && (typeof note.detail !== 'string' || note.detail.trim() === '')) {
    errors.push('verify 必须留下 detail')
  }
  if (!['low', 'mid', 'high'].includes(note.conf)) errors.push(`conf 只能是 low/mid/high，收到 ${note.conf}`)
  return errors
}

/**
 * 找出悬空引用（SPEC §4.6 的 id 命名空间精神）：
 * 指向不存在的事实卡 / note / 开环时，必须拒收或标 dangling，不能静默接受。
 */
export function danglingRefs(note, { facts, notes, loops }) {
  const known = new Set()
  for (const id of facts.keys()) known.add(id)
  for (const note2 of notes) known.add(note2.id)
  for (const id of loops.keys()) known.add(id)
  return note.refs.filter((ref) => !known.has(ref))
}

/** 判决缓存：同一 claim 已验过，第二次直接引用，不再取 detail（SPEC §2.2）。 */
export function findVerdict(notes, claim) {
  for (let index = notes.length - 1; index >= 0; index -= 1) {
    const note = notes[index]
    if (note.kind === 'verify' && note.claim === claim) return note
  }
  return undefined
}
