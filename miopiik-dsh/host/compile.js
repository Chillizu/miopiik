/**
 * Ink 的编译 —— SPEC §3.1 / §3.2。
 *
 * 把 Operator 的产物编译成「对话能消化的一条预览」：去术语、留证据、标置信。
 * 关于 Operator 的 note 从产物生成，不从 Operator 自述生成 —— 这里只信 resultText。
 * 编译失败不编造：降级为一条带原文指针的 preview，让 Mind 自己判断要不要看。
 */

/** 预览的 claim 是给对话用的：只留契约目标的一小段，绝不搬原文。 */
function clip(text, max = 26) {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

const COMPILE_SYSTEM = `You are Ink, the backstage compiler of MiOpIIk.
You receive the final report of a background Operator, the contract it was given, and Mind's recent statements to the user.
Compile the result into ONE note for Mind, the conversational agent. Mind never sees the raw report.
Output STRICT JSON only, no prose, no markdown fences:
{"kind":"preview"|"absorb","claim":"<=40 chars, concrete, no jargon","question":"a question Mind can ask the user, or empty","conf":"low"|"mid"|"high","detail":"the evidence that matters, <=120 chars","contradicts":true|false,"contradictStatement":"exact words Mind said that this report contradicts, or empty","contradictsUtterance":"U-n of the contradicted statement if listed, else empty"}
Rules:
- kind="preview" only when the report changes what the user or Mind should do next, or answers something still open. Otherwise "absorb".
- claim states what changed, not what was done. No "I completed" phrasing.
- question must be answerable by the user in one sentence.
- Never invent facts that are not in the report. If unsure, lower conf.
- Set contradicts=true ONLY when the report directly contradicts something Mind said to the user (quote it verbatim, and name its U-n when listed). Mind decides later whether and when to correct; your job is to make the conflict visible.
- The listed statements may be old. An old statement contradicted by new evidence is exactly what this field exists for.`

/** 从模型输出里抽 JSON（容忍代码围栏与前后废话）。 */
export function parseCompileOutput(text) {
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
  const kind = data?.kind === 'preview' ? 'preview' : data?.kind === 'absorb' ? 'absorb' : null
  if (kind === null) return null
  const claim = typeof data.claim === 'string' ? data.claim.trim() : ''
  if (claim === '') return null
  const question = typeof data.question === 'string' ? data.question.trim() : ''
  const conf = ['low', 'mid', 'high'].includes(data.conf) ? data.conf : 'mid'
  const detail = typeof data.detail === 'string' ? data.detail : null
  const contradicts = data.contradicts === true
  const contradictStatement =
    contradicts && typeof data.contradictStatement === 'string' ? data.contradictStatement.trim() : ''
  const contradictsUtterance =
    contradicts && typeof data.contradictsUtterance === 'string' ? data.contradictsUtterance.trim() : ''
  return {
    kind,
    claim,
    question: question === '' ? null : question,
    conf,
    detail,
    contradicts,
    contradictStatement,
    contradictsUtterance,
  }
}

/** 降级预览：编译失败或超时也要让 Mind 有得看；原文进 detail，绝不编造。 */
export function fallbackPreview(job, claim, question, rawText = null) {
  const text = rawText === null ? '' : String(rawText).trim()
  return {
    kind: 'preview',
    claim,
    why: 'compile:fallback',
    question,
    conf: 'low',
    refs: [job.id],
    loops: [job.loopId],
    branch: job.branchId ?? null,
    detail: text === '' ? null : ['## Operator 原始报告', text.slice(0, 20_000)].join('\n'),
  }
}

export function resolveModel(ctx, engine, config) {
  const configured = config?.inkModel
  if (configured?.provider !== undefined && configured?.model !== undefined) {
    return { provider: String(configured.provider), model: String(configured.model) }
  }
  const selection = engine?.modelHint
  if (selection?.provider !== undefined && selection?.model !== undefined) return selection
  try {
    const current = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (current?.provider !== undefined && current?.model !== undefined) {
      return { provider: current.provider, model: current.model }
    }
  } catch {
    // 没有默认模型服务时走降级。
  }
  return undefined
}

/**
 * 编译一份 Operator 结果。
 * @returns 一条 note 输入（交给 engine.deliverNote），失败时返回降级 preview。
 */
export async function compileResult({ ctx, engine, job, resultText, config, warn }) {
  const text = String(resultText ?? '').trim()
  if (text === '') return fallbackPreview(job, `「${clip(job.contract?.goal ?? job.label)}」没有产出`, '要不要重试？')

  const llm = (() => {
    try {
      return ctx.get('llm')
    } catch {
      return undefined
    }
  })()
  const model = resolveModel(ctx, engine, config)
  if (llm === undefined || model === undefined) {
    return fallbackPreview(job, `「${clip(job.contract?.goal ?? job.label)}」有结果了`, '要不要看原始结果？', text)
  }

  const ask = async (reminder) => {
    let out = ''
    const stream = llm.stream({
      provider: model.provider,
      model: model.model,
      system: COMPILE_SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                `## Contract goal\n${job.contract?.goal ?? job.label}`,
                `## Mind 对用户说过的话（含较早的；可能是 claim，也可能说错）\n${
                  (engine?.relevantUtterances?.(`${job.contract?.goal ?? job.label}\n${text}`, { recent: 4, similar: 4 }) ?? [])
                    .map((entry) => (typeof entry === 'string' ? entry : `${entry.id}｜${entry.text}`))
                    .map((line) => `- ${line}`)
                    .join('\n') || '（无）'
                }`,
                `## Operator report (raw)\n${text.slice(0, 12000)}`,
                ...(reminder === null ? [] : ['', reminder]),
              ].join('\n\n'),
            },
          ],
        },
      ],
      maxTokens: 2200,
      reasoningEffort: 'low',
      signal: AbortSignal.timeout(90_000),
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta') out += chunk.text ?? ''
    }
    return out
  }

  let output = ''
  let failure = null
  try {
    output = await ask(null)
  } catch (error) {
    failure = `stream:${String(error?.message ?? error).slice(0, 60)}`
    warn?.(`Ink 编译调用失败：${failure}`)
  }

  let parsed = parseCompileOutput(output)
  if (parsed === null && failure === null) {
    // 一次重试：模型偶尔会加解说或代码围栏，明确要它只吐 JSON。
    failure = `parse(len=${String(output).length}):${String(output).slice(0, 60)}`
    try {
      output = await ask('上一次的输出不是可直接解析的 JSON。只输出那一个 JSON 对象，不要任何其他文字。')
      parsed = parseCompileOutput(output)
      if (parsed !== null) failure = null
    } catch (error) {
      failure = `retry:${String(error?.message ?? error).slice(0, 60)}`
    }
  }

  if (parsed === null) {
    const note = fallbackPreview(job, `「${clip(job.contract?.goal ?? job.label)}」有结果了`, '要不要看原始结果？', text)
    note.why = `compile:fallback (${failure ?? 'unknown'})`
    return note
  }

  if (parsed.kind === 'absorb') {
    return {
      kind: 'absorb',
      claim: parsed.claim,
      why: 'compile:no-signal',
      conf: parsed.conf,
      refs: [],
      loops: [],
      detail: null,
    }
  }

  return {
    kind: 'preview',
    claim: parsed.claim,
    why: 'compile:operator-result',
    conf: parsed.conf,
    refs: [job.id],
    loops: [job.loopId],
    question: parsed.question ?? '要不要看看结果？',
    detail: [parsed.detail, '', '## Operator 原始报告', text.slice(0, 20_000)].filter(Boolean).join('\n').trim(),
  }
}
