/**
 * 对话编译 —— 中间层读自己的连续上下文，产出「候选结论 / 候选开环」。
 *
 * 这是 SPEC §3.1 的对话侧：Ink 不只在 Operator 交回产物时编译，
 * 也在每回合结束时读自己那份 append 上来的上下文，把这一轮的判断落成候选。
 *
 * 出口是收件箱的一条 preview：Mind 决定记不记，Ink 不直接落账。
 * 硬约束：**没有出处不产**——每条候选必须引用一条可指认的 U-n，否则丢弃；
 * 解析不出来或没有东西可产时返回 null，不投降级预览（对话候选不值得打扰）。
 */
import { resolveModel } from './compile.js'

export const LOOP_TYPES = Object.freeze([
  'unanswered-question',
  'awaiting-user',
  'pending-option',
  'promise',
  'pending-dispatch',
  'forming-intent',
])

const CONVERSATION_SYSTEM = `You are Ink, the middle layer of MiOpIIk. You are given your own continuous context: the recent dialogue between Mind (the conversational agent) and the user, pushed into it as it happens. You never talk to the user. Your job is to distill what this stretch of conversation actually produced, so Mind can decide whether to record it.

Output STRICT JSON only, no prose, no markdown fences:
{"claims":[{"claim":"<=60 chars","refs":["U-n"],"conf":"low"|"mid"|"high","supersedes":"F-n or empty"}],
"loops":[{"type":"unanswered-question"|"awaiting-user"|"pending-option"|"promise"|"pending-dispatch"|"forming-intent","text":"one sentence","refs":["U-n"],"closureCondition":"what would close it"}],
"question":"one question Mind can ask the user, in the language of the conversation"}

Rules:
- Only record what the user stated or confirmed, or what Mind concluded with evidence in the conversation. Never invent facts or decisions.
- Every claim and every loop MUST cite at least one U-n from the listed utterances. Items without a citation will be dropped.
- A claim must be a conclusion that would change future judgment ("X is the case because Y"), not a summary of what was discussed, and not raw material.
- Maximum 3 claims and 3 loops. Fewer is better. If nothing solid, return empty arrays.
- Loops are things still hanging between the user and Mind: an unanswered question, something waiting for the user, an open option, a promise, a draft pending approval, a half-formed intent.
- Write claim/text in the language of the conversation.`

/** 从模型输出里抽 JSON（容忍代码围栏与前后废话）。 */
export function parseConversationOutput(text, utterances = []) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const cleaned = text.replace(/```[a-zA-Z]*/gu, '```')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let data
  try {
    data = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
  const known = new Set(
    (Array.isArray(utterances) ? utterances : [])
      .map((entry) => (typeof entry === 'string' ? entry : entry?.id))
      .filter((id) => typeof id === 'string' && /^U-\d+$/u.test(id)),
  )
  const cite = (refs) =>
    (Array.isArray(refs) ? refs : [])
      .map((ref) => String(ref).trim())
      .filter((ref) => known.has(ref))
      .slice(0, 4)

  const claims = []
  for (const raw of Array.isArray(data.claims) ? data.claims : []) {
    const claim = typeof raw?.claim === 'string' ? raw.claim.trim() : ''
    const refs = cite(raw?.refs)
    if (claim === '' || refs.length === 0) continue
    if (claims.some((entry) => entry.claim === claim)) continue
    claims.push({
      claim: claim.slice(0, 120),
      refs,
      conf: ['low', 'mid', 'high'].includes(raw?.conf) ? raw.conf : 'low',
      supersedes: typeof raw?.supersedes === 'string' ? raw.supersedes.trim() : '',
    })
    if (claims.length >= 3) break
  }

  const loops = []
  for (const raw of Array.isArray(data.loops) ? data.loops : []) {
    const loopText = typeof raw?.text === 'string' ? raw.text.trim() : ''
    const refs = cite(raw?.refs)
    if (loopText === '' || refs.length === 0) continue
    if (!LOOP_TYPES.includes(raw?.type)) continue
    loops.push({
      type: raw.type,
      text: loopText.slice(0, 160),
      pointer: refs[0],
      closureCondition: typeof raw?.closureCondition === 'string' ? raw.closureCondition.trim() : '',
    })
    if (loops.length >= 3) break
  }

  if (claims.length === 0 && loops.length === 0) return null
  const question = typeof data.question === 'string' && data.question.trim() !== '' ? data.question.trim() : ''
  return { claims, loops, question }
}

/** 把候选组装成一条 note 输入（交给 engine.deliverNote）。 */
export function buildCandidateNote(parsed) {
  const claims = parsed?.claims ?? []
  const loops = parsed?.loops ?? []
  const parts = []
  if (claims.length > 0) {
    parts.push('## 候选结论')
    for (const entry of claims) {
      parts.push(`- ${entry.claim}（出处 ${entry.refs.join('、')}，置信 ${entry.conf}${entry.supersedes === '' ? '' : `，取代 ${entry.supersedes}`}）`)
    }
  }
  if (loops.length > 0) {
    parts.push('', '## 候选开环')
    for (const entry of loops) {
      parts.push(`- [${entry.type}] ${entry.text}（出处 ${entry.pointer}${entry.closureCondition === '' ? '' : `；闭合条件：${entry.closureCondition}`}）`)
    }
  }
  const refs = [...new Set([...claims.flatMap((entry) => entry.refs), ...loops.map((entry) => entry.pointer)])]
  return {
    kind: 'preview',
    why: 'compile:conversation',
    claim: `这段里像是有 ${claims.length} 条结论、${loops.length} 条悬着的话`,
    question: parsed.question !== '' ? parsed.question : '要不要把这几条记为已定结论？',
    conf: 'low',
    refs,
    loops: [],
    branch: null,
    newConclusion: true,
    detail: parts.join('\n'),
  }
}

/**
 * 调一次模型，读 Ink 自己的上下文，产出候选。
 * 失败、无模型、没有可引用的原话时返回 null —— 不编造、不投降级预览。
 */
export async function compileConversation({ ctx, engine, config, warn, utterances, contextText, facts, loops, onSkip = null }) {
  const llm = (() => {
    try {
      return ctx?.get?.('llm')
    } catch {
      return undefined
    }
  })()
  const model = resolveModel(ctx, engine, config)
  if (llm === undefined || model === undefined) {
    onSkip?.('no-llm-or-model')
    return null
  }

  const ask = async (reminder) => {
    let out = ''
    const stream = llm.stream({
      provider: model.provider,
      model: model.model,
      system: CONVERSATION_SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                '## Your continuous context (oldest → newest)',
                contextText,
                '## Utterances you may cite',
                utterances.map((entry) => `- ${entry.id}｜${entry.role}｜${entry.text}`).join('\n') || '（无）',
                '## Active facts (for supersedes detection)',
                facts.length === 0 ? '（无）' : facts.map((fact) => `- ${fact.id}｜${fact.claim}`).join('\n'),
                '## Active loops',
                loops.length === 0 ? '（无）' : loops.map((loop) => `- ${loop.id}｜${loop.text}`).join('\n'),
                ...(reminder === null ? [] : ['', reminder]),
              ].join('\n\n'),
            },
          ],
        },
      ],
      maxTokens: 1600,
      signal: AbortSignal.timeout(60_000),
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta') out += chunk.text ?? ''
    }
    return out
  }

  let output = ''
  try {
    output = await ask(null)
  } catch (error) {
    const reason = `stream:${String(error?.message ?? error).slice(0, 80)}`
    warn?.(`Ink 对话编译失败：${reason}`)
    onSkip?.(reason)
    return null
  }
  let parsed = parseConversationOutput(output, utterances)
  if (parsed === null) {
    try {
      output = await ask('上一次的输出不是可直接解析的 JSON。只输出那一个 JSON 对象，不要任何其他文字。')
      parsed = parseConversationOutput(output, utterances)
    } catch (error) {
      onSkip?.(`retry:${String(error?.message ?? error).slice(0, 60)}`)
      return null
    }
  }
  if (parsed === null) onSkip?.(`parse:${String(output).slice(0, 120)}`)
  return parsed
}
