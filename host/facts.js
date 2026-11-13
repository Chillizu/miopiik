/**
 * 事实卡 —— SPEC §2.3。
 *
 * claim + provenance + 失效条件；只增不删，失效标 stale。
 * source=user 权威高于 Operator 的任何推断（SPEC §5.6）。
 */

export const FACT_CONFIDENCE = Object.freeze(['low', 'mid', 'high'])

/** 造一张事实卡（未落盘）。 */
export function makeFact(input) {
  const at = input.at ?? Date.now()
  return {
    id: input.id,
    claim: String(input.claim ?? '').trim(),
    provenance: Array.isArray(input.provenance) ? input.provenance.map(String) : [],
    conf: FACT_CONFIDENCE.includes(input.conf) ? input.conf : 'mid',
    source: input.source ?? 'ink',
    validUntil: input.validUntil ?? null,
    stale: false,
    epoch: input.epoch ?? 0,
    createdAt: at,
    revisedAt: at,
    invalidatedAt: null,
    invalidatedReason: null,
  }
}

export function validateFact(fact) {
  const errors = []
  if (typeof fact !== 'object' || fact === null) return ['fact 不是对象']
  if (typeof fact.claim !== 'string' || fact.claim.trim() === '') errors.push('缺少 claim')
  if (!FACT_CONFIDENCE.includes(fact.conf)) errors.push(`conf 只能是 low/mid/high，收到 ${fact.conf}`)
  if (!['user', 'ink', 'operator'].includes(fact.source)) errors.push(`未知 source: ${fact.source}`)
  return errors
}

/** 权威序：用户自己做的成果高于 Ink，Ink 高于 Operator 的推断。 */
export function authorityRank(fact) {
  if (fact.source === 'user') return 2
  if (fact.source === 'ink') return 1
  return 0
}

/** 还在生效的事实卡（失效的保留在账本里，但不进工作记忆）。 */
export function activeFacts(facts) {
  return [...facts.values()]
    .filter((fact) => !fact.stale)
    .sort((a, b) => authorityRank(b) - authorityRank(a) || b.revisedAt - a.revisedAt)
}
