/**
 * 判例库 —— SPEC §2.4 / §3.2。
 *
 * Ink 回答 Operator 的每一条判断与答复都留痕；同类问题第二次直接引判例。
 * 匹配是确定性的（CJK 二元组 + ASCII 词的 Jaccard 重叠），不调模型：
 * 能引用就自答，匹配不上就上报——判据落在出口，不落在"想不想得起来"。
 */

const CJK = /[\u4e00-\u9fffa-zA-Z0-9]/u

/** 把一句话切成可比较的 token 集合：ASCII 词 + 中文二元组。 */
export function tokens(text) {
  const raw = String(text ?? '').toLowerCase()
  const ascii = raw.match(/[a-z0-9_]{2,}/gu) ?? []
  const chars = [...raw].filter((ch) => CJK.test(ch) && !/[a-zA-Z0-9]/.test(ch))
  const bigrams = []
  for (let index = 0; index < chars.length - 1; index += 1) bigrams.push(chars[index] + chars[index + 1])
  return new Set([...ascii, ...bigrams])
}

/** 覆盖率：问题里有多少 token 被候选答案覆盖（问答场景比 Jaccard 更贴切）。 */
export function coverage(query, candidate) {
  const left = tokens(query)
  const right = tokens(candidate)
  if (left.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / left.size
}

/** Jaccard 重叠：0 = 无关，1 = 完全同义。 */
export function overlap(a, b) {
  const left = tokens(a)
  const right = tokens(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

export function makeCase(input) {
  return {
    id: input.id,
    question: String(input.question ?? '').trim(),
    answer: String(input.answer ?? '').trim(),
    citations: Array.isArray(input.citations) ? input.citations.map(String) : [],
    domain: input.domain ?? 'operator-query',
    at: input.at ?? Date.now(),
  }
}

/** 相似度：Jaccard 与双向覆盖取最大，短问句也能对上长判例。 */
export function similarity(a, b) {
  return Math.max(overlap(a, b), coverage(a, b), coverage(b, a))
}

/** 在判例库里找最相似的一条；低于阈值就当没找到。 */
export function matchCase(query, cases, { min = 0.3 } = {}) {
  let best = null
  for (const entry of cases) {
    const score = similarity(query, entry.question)
    if (best === null || score > best.score) best = { case: entry, score }
  }
  if (best === null || best.score < min) return null
  return best
}

/** 在事实卡里找最相关的一张（用覆盖率：事实需要覆盖问题）。 */
export function matchFacts(query, facts, { min = 0.3 } = {}) {
  let best = null
  for (const fact of facts) {
    const score = coverage(query, fact.claim)
    if (best === null || score > best.score) best = { fact, score }
  }
  if (best === null || best.score < min) return null
  return best
}
