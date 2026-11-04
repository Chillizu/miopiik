/**
 * Mind 的窄工具面 —— SPEC §1.8 / §3.3 / §4.3。
 *
 * 只有四个工具，全部是「对话级 + 查询/召回」：
 *  ink_status / ink_loops / ink_facts / ink_inbox
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

export function registerTools(ctx, engines) {
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
          action: { type: 'string', enum: ['list', 'read', 'star', 'unstar', 'defer'] },
          id: { type: 'string', description: 'Inbox item id such as I-1.' },
          all: { type: 'boolean', description: 'List the whole pending view, not just the top tiers.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const engine = engineFor(exec)
        if (args.action === 'list') {
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
}
