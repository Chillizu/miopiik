/**
 * Mind 的窄工具面 —— SPEC §1.8 / §3.3 / §4.3。
 *
 * 全部是「对话级 + 查询/召回」，长程执行能力不在这里：
 *  ink_status / ink_loops / ink_facts / ink_inbox / ink_epoch / ink_brief / ink_dispatch / ink_commit
 * 长程执行能力不在这里；Operator 的派发是后续批次的事。
 * 工具只读写本会话的 Ink 账本，不写对话、不直接回复用户。
 * 子 agent（Operator）在 index.js 里被 restrict 掉这组工具。
 */

import { LOOP_TYPES } from './loops.js'

const RESULT_SCHEMA = { type: 'object', additionalProperties: true }

function render(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function tool(definition) {
  return { ...definition, output: { schema: RESULT_SCHEMA, render } }
}

export function registerTools(ctx, engines, operator) {
  const engineFor = (exec) => {
    const sessionId = exec?.agent?.session?.id
    const engine = sessionId === undefined ? undefined : engines.get(String(sessionId))
    if (engine === undefined) throw new Error('MiOpIIk: 这个会话还没有 Ink 运行时')
    return engine
  }

  ctx.tools.register(
    tool({
      name: 'ink_status',
      description:
        'Read the Ink backstage state of this conversation: open loops, fact cards, inbox counts, epoch and day. Ink never talks to the user; this is the only window into it.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      async execute(_args, exec) {
        return engineFor(exec).status()
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'ink_loops',
      description:
        'The open threads of this conversation: things still hanging between you and the user. Not a todo list — no dates, no owners. You register them as you reply, and only you close them; Ink can only hint that one looks answered.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'touch', 'close', 'drop'] },
          id: { type: 'string', description: 'Loop id such as L-3.' },
          text: { type: 'string', description: 'One sentence, readable without context.' },
          type: {
            type: 'string',
            enum: LOOP_TYPES,
            description:
              'unanswered-question | awaiting-user | pending-option | promise | pending-dispatch | forming-intent',
          },
          pointer: { type: 'string', description: 'Where this came from: turn, branch, or fact id.' },
          closureCondition: { type: 'string', description: 'What would close it.' },
          reason: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const engine = engineFor(exec)
        switch (args.action) {
          case 'list':
            return { loops: engine.listLoops() }
          case 'add': {
            const loop = await engine.addLoop({
              text: args.text,
              type: args.type,
              pointer: args.pointer,
              closureCondition: args.closureCondition,
            })
            return { loop }
          }
          case 'touch':
            if (typeof args.id !== 'string') throw new Error('touch 需要 id')
            return { loop: await engine.touchLoop(args.id) }
          case 'close':
            if (typeof args.id !== 'string') throw new Error('close 需要 id')
            return { loop: await engine.closeLoop(args.id, { reason: args.reason ?? null, by: 'mind' }) }
          case 'drop':
            if (typeof args.id !== 'string') throw new Error('drop 需要 id')
            return { loop: await engine.dropLoop(args.id, { reason: args.reason ?? null, by: 'mind' }) }
          default:
            throw new Error(`未知 action: ${args.action}`)
        }
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'ink_facts',
      description:
        'Fact cards: conclusions we settled together, each with provenance and an invalidation condition. Edit one beats explaining again. source=user outranks anything inferred by Operator.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'revise', 'invalidate'] },
          id: { type: 'string', description: 'Fact id such as F-2.' },
          claim: { type: 'string' },
          provenance: { type: 'array', items: { type: 'string' }, description: 'Where it came from.' },
          conf: { type: 'string', enum: ['low', 'mid', 'high'] },
          source: { type: 'string', enum: ['user', 'ink', 'operator'] },
          validUntil: { type: 'string', description: 'When this stops being true, if it can expire.' },
          reason: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const engine = engineFor(exec)
        switch (args.action) {
          case 'list':
            return { facts: engine.listFacts() }
          case 'add': {
            const fact = await engine.addFact({
              claim: args.claim,
              provenance: args.provenance,
              conf: args.conf,
              source: args.source,
              validUntil: args.validUntil,
            })
            return { fact }
          }
          case 'revise': {
            if (typeof args.id !== 'string') throw new Error('revise 需要 id')
            const patch = {}
            for (const key of ['claim', 'conf', 'validUntil', 'provenance', 'source']) {
              if (args[key] !== undefined) patch[key] = args[key]
            }
            return { fact: await engine.reviseFact(args.id, patch) }
          }
          case 'invalidate':
            if (typeof args.id !== 'string') throw new Error('invalidate 需要 id')
            return { fact: await engine.invalidateFact(args.id, args.reason ?? null) }
          default:
            throw new Error(`未知 action: ${args.action}`)
        }
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'ink_inbox',
      description:
        "Ink's inbox: things waiting for your attention, already compiled into one-line previews. Three actions are yours — open, read, or push backstage.",
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'open', 'read', 'star', 'unstar', 'defer'] },
          id: { type: 'string', description: 'Inbox item id such as I-1.' },
          all: { type: 'boolean', description: 'List the whole pending view, not just the top tiers.' },
          zone: { type: 'string', enum: ['unread', 'history', 'starred'], description: 'Which inbox area to list.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const engine = engineFor(exec)
        if (args.action === 'open') {
          if (typeof args.id !== 'string') throw new Error('open 需要 id')
          return engine.openInboxItem(args.id)
        }
        if (args.action === 'list') {
          const zone = args.zone ?? 'unread'
          if (zone !== 'unread') return { zone, items: engine.inboxZone(zone) }
          const view = engine.inboxView({ all: args.all === true })
          return {
            previews: view.previews.map((entry) => ({
              id: entry.item.id,
              tier: ['T0', 'T1', 'T2', 'T3'][entry.tier],
              loop: entry.item.loopId,
              status: entry.item.status,
              claim: entry.item.claim,
              question: entry.item.question,
            })),
            hidden: view.hiddenCount,
            byTier: view.byTier,
          }
        }
        if (typeof args.id !== 'string') throw new Error(`${args.action} 需要 id`)
        await engine.markInbox(args.id, args.action)
        return { ok: true, id: args.id, action: args.action }
      },
    }),
  )
  ctx.tools.register(
    tool({
      name: 'ink_dispatch',
      description:
        'Hand a well-formed piece of work to a background Operator. The contract must be complete: goal, deliverables, acceptance criteria, acceptance sample, boundary, budget. If any is missing this refuses and tells you what is missing — keep talking with the user instead of dispatching on a half-formed picture.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'One-sentence restatement of the goal, as the user would recognize it.' },
          deliverables: { type: 'string', description: 'What exactly is handed back.' },
          acceptance: { type: 'string', description: 'How it will be judged done.' },
          acceptanceSample: { type: 'string', description: 'What "good" roughly looks like — a sample beats a standard.' },
          boundary: { type: 'string', description: 'What must not change.' },
          budget: { type: 'string', description: 'Time/cost budget, stated in the contract.' },
          draft: {
            type: 'boolean',
            description: 'Exploratory pass: only goal is required, the result stays in the draft area and never reaches the user. Use it when you want to look before committing to a full contract.',
          },
          branch: {
            type: 'string',
            description: 'Fishbone branch label: which conversation thread this work grew out of. Reuses an open branch with the same label, otherwise forks a new one at the current turn.',
          },
        },
        required: ['goal'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        if (operator === undefined) throw new Error('MiOpIIk: 没有可用的 Operator 派发器')
        const engine = engineFor(exec)
        let branch = null
        const label = typeof args.branch === 'string' ? args.branch.trim() : ''
        if (label !== '') {
          const existing = engine.listBranches().find((entry) => entry.label === label)
          branch = existing ?? (await engine.openBranch({ label, summary: args.goal }))
        }
        const started = await operator.start({ agent: exec.agent, engine, input: args, branchId: branch?.id ?? null })
        return { ...started, branch: branch?.id ?? null }
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'ink_commit',
      description:
        'The one outward gate, bound to a commit. Ask the user to accept or reject a whole change — the user only needs to answer "行" or "不行". Never batch several questions here, and never ask the user to repair the work: rejection must be complete by itself.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'One line naming the change.' },
          summary: { type: 'string', description: 'What the user is accepting, in their terms.' },
          confidence: {
            type: 'string',
            enum: ['low', 'mid', 'high'],
            description: 'How sure you are it will be accepted. low refuses the gate: keep it in the draft area instead.',
          },
          draftId: { type: 'string', description: 'The draft this commit promotes, if any. Approval settles it as committed; rejection settles it as rejected — no repair is asked of the user.' },
        },
        required: ['title', 'summary'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        if (args.confidence === 'low') {
          throw new Error('低置信不提交：留在草稿区，继续做或丢掉（SPEC §4.1）')
        }
        const questions = (() => {
          try {
            return ctx.get('userQuestions')
          } catch {
            return undefined
          }
        })()
        if (questions === undefined) throw new Error('这个 profile 没有 userQuestions 服务，无法立闸门')
        const questionId = `miopiik-commit-${Date.now()}`
        const answer = await questions.ask({
          agent: exec.agent,
          questions: [
            {
              id: questionId,
              header: 'commit',
              question: `要提交「${args.title}」吗？`,
              detail: args.summary,
              options: [{ label: '行' }, { label: '不行' }],
            },
          ],
        })
        const item = answer?.answers?.find((entry) => entry.id === questionId)
        const selected = item?.selected ?? []
        const approved = selected.includes('行') || selected.includes('approve') || selected.includes('Approve')
        let draft = null
        if (typeof args.draftId === 'string' && args.draftId !== '') {
          draft = await engineFor(exec).settleDraft(args.draftId, {
            status: approved ? 'committed' : 'rejected',
            reason: approved ? 'gate:approved' : 'gate:rejected-by-user',
          })
        }
        return { approved, selected, custom: item?.custom ?? null, draft }
      },
    }),
  )
  ctx.tools.register(
    tool({
      name: 'ink_brief',
      description:
        'The handoff briefing between days. actions: "materials" returns what Ink knows (open loops, running jobs, drafts, inbox); "save" writes the briefing YOU compose (progress/loops/running/drafts/next); "latest" reads the last one. The briefing is written by you, not by Ink — a machine-written one makes tomorrow\'s you unrecognizable.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['materials', 'save', 'latest'] },
          progress: { type: 'string', description: 'What got done today.' },
          loops: { type: 'string', description: 'Which threads are still alive.' },
          running: { type: 'string', description: 'What is still running in the background.' },
          drafts: { type: 'string', description: 'What is sitting unfinished in the draft area.' },
          next: { type: 'string', description: 'What you want to talk about next — your own opinion, not a summary.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const engine = engineFor(exec)
        if (args.action === 'materials') return engine.briefingMaterials()
        if (args.action === 'latest') return { briefing: engine.latestBriefing() }
        const briefing = await engine.saveBriefing({
          progress: args.progress,
          loops: args.loops,
          running: args.running,
          drafts: args.drafts,
          next: args.next,
        })
        return { briefing }
      },
    }),
  )
  ctx.tools.register(
    tool({
      name: 'ink_epoch',
      description:
        'Mark that the conversation moved to a new topic epoch. Only Mind judges a topic switch; Ink uses it to mark older inbox previews as stale (they drop one tier, never get deleted).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['advance'] },
          note: { type: 'string', description: 'What changed the topic, one line.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        if (args.action !== 'advance') throw new Error(`未知 action: ${args.action}`)
        return engineFor(exec).advanceEpoch({ note: args.note ?? null })
      },
    }),
  )
  ctx.tools.register(
    tool({
      name: 'ink_draft',
      description:
        'The draft area: work that is not ready for the commit gate. Drafts are discardable by construction, age out after a week, and never reach the user. Promote one through ink_commit when you are sure it will be accepted.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'drop'] },
          id: { type: 'string', description: 'Draft id such as P-1.' },
          title: { type: 'string' },
          summary: { type: 'string' },
          artifact: { type: 'string', description: 'Where the work lives (file path, task id, or note).' },
          conf: { type: 'string', enum: ['low', 'mid', 'high'] },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const engine = engineFor(exec)
        if (args.action === 'list') return { drafts: engine.listDrafts() }
        if (args.action === 'add') {
          const draft = await engine.addDraft({
            title: args.title,
            summary: args.summary,
            artifact: args.artifact,
            conf: args.conf,
          })
          return { draft }
        }
        if (typeof args.id !== 'string') throw new Error('drop 需要 id')
        const draft = await engine.settleDraft(args.id, { status: 'dropped', reason: 'mind:dropped' })
        return { draft }
      },
    }),
  )
  ctx.tools.register(
    tool({
      name: 'ink_ask',
      description:
        'Operator-side channel: ask Ink about shared state (facts, open threads, precedents). Ink answers only by citation; if it would have to invent, it escalates to Mind and tells you to proceed on your best reading. Mind does not see this tool.',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string', description: 'One concrete question.' } },
        required: ['question'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        if (operator === undefined || typeof operator.engineForChild !== 'function') {
          throw new Error('MiOpIIk: 没有可用的 Ink 运行时映射')
        }
        const sessionId = String(exec.agent?.session?.id ?? '')
        // Operator 子会话走子会话映射；Mind 自己问也能问（查询/召回属窄工具面）。
        const engine = operator.engineForChild(sessionId) ?? engines.get(sessionId)
        if (engine === undefined) throw new Error('MiOpIIk: 这个会话没有对应的 Ink 运行时')
        return engine.answerOperatorQuestion({ question: args.question, childId: sessionId })
      },
    }),
  )
  ctx.tools.register(
    tool({
      name: 'ink_branch',
      description:
        'The fishbone: branches that grew out of a point in this conversation. A branch is not a task — it is "which sentence this work came from". Open one, keep its one-line summary current, and merge it back into the trunk when it has a conclusion.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'open', 'get', 'summary', 'context', 'merge', 'abandon'] },
          id: { type: 'string', description: 'Branch id such as B-1.' },
          label: { type: 'string', description: 'Short name of the thread, as the user would say it.' },
          summary: { type: 'string', description: 'One line: what this branch is after.' },
          claim: { type: 'string', description: 'For merge: the conclusion, one line.' },
          detail: { type: 'string', description: 'For merge: the evidence that matters.' },
          forkedAtTurn: { type: 'number', description: 'Which conversation turn this branch grew out of.' },
          premise: {
            type: 'string',
            description: 'The premise at the fork: why this branch exists and what the context was, in your own words.',
          },
          quotes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Verbatim lines from the trunk that this branch depends on. Quote, never paraphrase.',
          },
          facts: {
            type: 'array',
            items: { type: 'string' },
            description: 'Fact ids this branch relies on (F-1, …).',
          },
          reason: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const engine = engineFor(exec)
        switch (args.action) {
          case 'list':
            return { branches: engine.listBranches({ includeSettled: true }) }
          case 'open': {
            const branch = await engine.openBranch({
              label: args.label,
              summary: args.summary,
              premise: args.premise,
              forkedAtTurn: args.forkedAtTurn,
            })
            return { branch }
          }
          case 'get': {
            if (typeof args.id !== 'string') throw new Error('get 需要 id')
            return engine.branchSlice(args.id)
          }
          case 'context': {
            if (typeof args.id !== 'string') throw new Error('context 需要 id')
            const branch = await engine.updateBranchContext(args.id, {
              premise: args.premise,
              quotes: args.quotes,
              facts: args.facts,
            })
            return { branch }
          }
          case 'summary': {
            if (typeof args.id !== 'string') throw new Error('summary 需要 id')
            return { branch: await engine.updateBranchSummary(args.id, args.summary) }
          }
          case 'merge': {
            if (typeof args.id !== 'string') throw new Error('merge 需要 id')
            return engine.mergeBranch(args.id, { claim: args.claim, detail: args.detail })
          }
          case 'abandon': {
            if (typeof args.id !== 'string') throw new Error('abandon 需要 id')
            return { branch: await engine.abandonBranch(args.id, { reason: args.reason }) }
          }
          default:
            throw new Error(`未知 action: ${args.action}`)
        }
      },
    }),
  )
  ctx.tools.register(
    tool({
      name: 'ink_fold',
      description:
        'Two-phase narrative fold. "propose" has Ink build a shadow fold (archive + loop settlements) without replacing anything. You then verify it while you still hold the old context — the only criterion is that every still-active open thread can be picked up again after folding. "approve" may carry your own rewritten archive. Nothing is replaced until you approve.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['propose', 'review', 'approve', 'reject', 'list'] },
          id: { type: 'string', description: 'Proposal id such as A-1.' },
          archive: { type: 'string', description: 'For approve: your own rewrite of the archive, in your words.' },
          reason: { type: 'string', description: 'For reject: what could not be picked up again.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const engine = engineFor(exec)
        switch (args.action) {
          case 'propose':
            return { proposal: await engine.proposeFold({ archive: args.archive ?? null }) }
          case 'list':
            return { proposals: engine.listFolds() }
          case 'review': {
            const id = args.id ?? engine.pendingFold()?.id
            if (typeof id !== 'string') throw new Error('没有待验收的提案')
            return engine.reviewFold(id)
          }
          case 'approve': {
            const id = args.id ?? engine.pendingFold()?.id
            if (typeof id !== 'string') throw new Error('没有待验收的提案')
            const compaction = (() => {
              try {
                return ctx.get('compaction')
              } catch {
                return null
              }
            })()
            return engine.settleFold(id, {
              approve: true,
              archive: args.archive ?? null,
              agent: exec.agent ?? null,
              compaction,
            })
          }
          case 'reject': {
            const id = args.id ?? engine.pendingFold()?.id
            if (typeof id !== 'string') throw new Error('没有待验收的提案')
            return engine.settleFold(id, { approve: false, reason: args.reason ?? null })
          }
          default:
            throw new Error(`未知 action: ${args.action}`)
        }
      },
    }),
  )
}
