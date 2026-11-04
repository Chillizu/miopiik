/**
 * 一个会话的 Ink 运行时（确定性部分）—— SPEC §3 / §4.3 / §5.6。
 *
 * Batch 2 只做机械可判定的部分：
 *  - 观测：把用户真人与助手最终消息记进 append-only 观测日志（不推思维链/草稿/重试）；
 *  - 老化：按天轴把开环推进到 dormant / folded（不删）；
 *  - 投递：开环进入休眠时生成一条带指针的预览（结尾是开环改写的疑问句），
 *    同一开环最多一条待读；
 *  - L3：把活跃开环 + 收件箱摘要拼成一段后台上下文，供 Mind 每轮看见。
 * 不做叙事、不编写答案、不向对话写内容。
 */

import { DORMANT_AFTER_DAYS, FOLDED_AFTER_DAYS, LOOP_TYPES, ACTIVE_LOOP_CAP, activeLoops, ageLoops, asQuestion, dayOf, makeLoop, overflowToDormant } from './loops.js'
import { makeItem, selectView } from './inbox.js'
import { makeNote, validateNote } from './notes.js'
import { activeFacts, makeFact, validateFact } from './facts.js'
import { appendRecord } from './store.js'

export const INK_TOOL_NAMES = Object.freeze(['ink_status', 'ink_loops', 'ink_facts', 'ink_inbox', 'ink_dispatch', 'ink_commit', 'ink_brief'])

const MAX_L3_LINES = 14

/** 从内容块里取纯文本（观测只收真人提示与助手最终消息，不碰思维链）。 */
export function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
    .trim()
}

export class Engine {
  constructor({ store, sessionId, now = () => Date.now() }) {
    this.store = store
    this.sessionId = sessionId
    this.now = now
    this.queue = Promise.resolve()
    this.turn = 0
  }

  get state() {
    return this.store.state
  }

  /** 串行化写操作：日志顺序就是事实顺序。 */
  enqueue(task) {
    const run = this.queue.then(task)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** 会话事件入口（来自 session/event）。只处理 SPEC §2.1 允许的四类。 */
  observe(event) {
    try {
      const type = event?.type
      if (type === 'user/message') {
        // 只收真人提示：goal 轮次、时间上下文、审批等系统注入不是用户说的话。
        if (event.data?.source?.kind !== 'user') return
        const text = textOf(event.data?.content)
        if (text !== '') this.enqueue(() => this.recordObservation('user', text, this.turn))
      } else if (type === 'assistant/message') {
        const text = textOf(event.data?.message?.content)
        const turn = event.data?.turn ?? this.turn
        if (text !== '') this.enqueue(() => this.recordObservation('assistant', text, turn))
      } else if (type === 'turn/start') {
        this.turn = event.data?.turn ?? this.turn + 1
      } else if (type === 'turn/end') {
        const turn = event.data?.turn ?? this.turn
        this.turn = turn
        this.enqueue(() => this.finishTurn(turn))
      } else if (type === 'compaction/summary') {
        this.enqueue(() => this.recordObservation('fold', '叙事被折叠（compaction）', this.turn))
      }
    } catch {
      // 观测层不允许把会话弄挂：单条事件解析失败就放弃这一条。
    }
  }

  async recordObservation(kind, text, turn) {
    const seq = this.state.counters.obs + 1
    await appendRecord(this.store, 'observations', {
      seq,
      at: this.now(),
      day: dayOf(this.now()),
      turn,
      kind,
      text: text.length > 4000 ? `${text.slice(0, 4000)}…` : text,
    })
    this.state.counters.obs = seq
  }

  /** 回合结束的确定性 Ink pass：老化 → 溢出折叠 → 休眠投递 → 记录回合边界。 */
  async finishTurn(turn) {
    const now = this.now()
    const today = dayOf(now)
    const epoch = this.state.epoch
    const loops = [...this.state.loops.values()]

    for (const [id, status] of ageLoops(loops, { today, epoch })) {
      const loop = this.state.loops.get(id)
      await appendRecord(this.store, 'loops', { op: 'status', loopId: id, status, at: now })
      if (status === 'dormant') await this.deliverAgingPreview(loop, { epoch, today })
    }

    for (const id of overflowToDormant([...this.state.loops.values()], ACTIVE_LOOP_CAP)) {
      await appendRecord(this.store, 'loops', { op: 'status', loopId: id, status: 'dormant', at: now })
    }

    await this.recordObservation('turn-end', '', turn)
  }

  /** 同一条开环只投递一次预览；投递内容以问题结尾（SPEC §3.3）。 */
  async deliverAgingPreview(loop, { epoch }) {
    for (const item of this.state.inbox.values()) {
      if (item.loopId === loop.id) return
    }
    const noteId = `D-${this.state.counters.note + 1}`
    const note = makeNote({
      id: noteId,
      kind: 'preview',
      claim: `「${loop.text}」已经悬了两天，还没合上`,
      why: 'aging:dormant-2d',
      refs: [loop.id],
      loops: [loop.id],
      conf: 'mid',
      question: asQuestion(loop),
      epoch,
      at: this.now(),
    })
    const errors = validateNote(note)
    if (errors.length > 0) return
    await appendRecord(this.store, 'notes', note)
    await appendRecord(this.store, 'inbox', {
      op: 'deliver',
      item: makeItem({
        id: `I-${this.state.counters.inbox + 1}`,
        noteId,
        loopId: loop.id,
        epoch,
        claim: note.claim,
        question: note.question,
        at: this.now(),
      }),
    })
  }

  // ── Mind 的窄工具面（由 tools.js 转接） ────────────────────────────────

  async addLoop(input) {
    const text = String(input.text ?? '').trim()
    if (text === '') throw new Error('开环必须有一句话')
    if (!LOOP_TYPES.includes(input.type)) throw new Error(`未知开环类型: ${input.type}`)
    const at = this.now()
    const loop = makeLoop({
      id: `L-${this.state.counters.loop + 1}`,
      text,
      type: input.type,
      pointer: input.pointer ?? null,
      closureCondition: input.closureCondition ?? null,
      turn: this.turn,
      epoch: this.state.epoch,
      at,
    })
    await this.enqueue(() => appendRecord(this.store, 'loops', { op: 'create', loop }))
    // 超限时按固定顺序折叠，不让模型裁量。
    for (const id of overflowToDormant([...this.state.loops.values()], ACTIVE_LOOP_CAP)) {
      await this.enqueue(() => appendRecord(this.store, 'loops', { op: 'status', loopId: id, status: 'dormant', at }))
    }
    return loop
  }

  async touchLoop(id) {
    const loop = this.state.loops.get(id)
    if (loop === undefined) throw new Error(`没有这条开环: ${id}`)
    const at = this.now()
    await this.enqueue(() =>
      appendRecord(this.store, 'loops', { op: 'touch', loopId: id, at, day: dayOf(at), turn: this.turn, epoch: this.state.epoch }),
    )
    return this.state.loops.get(id)
  }

  async closeLoop(id, { reason = null, by = 'mind' } = {}) {
    if (!this.state.loops.has(id)) throw new Error(`没有这条开环: ${id}`)
    await this.enqueue(() => appendRecord(this.store, 'loops', { op: 'close', loopId: id, at: this.now(), by, reason }))
    return this.state.loops.get(id)
  }

  async dropLoop(id, { reason = null, by = 'mind' } = {}) {
    if (!this.state.loops.has(id)) throw new Error(`没有这条开环: ${id}`)
    await this.enqueue(() => appendRecord(this.store, 'loops', { op: 'drop', loopId: id, at: this.now(), by, reason }))
    return this.state.loops.get(id)
  }

  listLoops() {
    return [...this.state.loops.values()].sort((a, b) => b.lastTouchedAt - a.lastTouchedAt)
  }

  async addFact(input) {
    const fact = makeFact({
      id: `F-${this.state.counters.fact + 1}`,
      claim: input.claim,
      provenance: input.provenance,
      conf: input.conf,
      source: input.source ?? 'ink',
      validUntil: input.validUntil,
      epoch: this.state.epoch,
      at: this.now(),
    })
    const errors = validateFact(fact)
    if (errors.length > 0) throw new Error(errors.join('；'))
    await this.enqueue(() => appendRecord(this.store, 'facts', { op: 'add', fact }))
    return fact
  }

  async reviseFact(id, patch) {
    if (!this.state.facts.has(id)) throw new Error(`没有这张事实卡: ${id}`)
    await this.enqueue(() => appendRecord(this.store, 'facts', { op: 'revise', factId: id, patch, at: this.now() }))
    return this.state.facts.get(id)
  }

  async invalidateFact(id, reason) {
    if (!this.state.facts.has(id)) throw new Error(`没有这张事实卡: ${id}`)
    await this.enqueue(() => appendRecord(this.store, 'facts', { op: 'invalidate', factId: id, at: this.now(), reason }))
    return this.state.facts.get(id)
  }

  listFacts() {
    return activeFacts(this.state.facts)
  }

  inboxView({ all = false } = {}) {
    const activeLoopIds = new Set(activeLoops(this.listLoops()).map((loop) => loop.id))
    return selectView([...this.state.inbox.values()], {
      currentEpoch: this.state.epoch,
      activeLoopIds,
      all,
    })
  }

  markInbox(id, action) {
    if (!this.state.inbox.has(id)) throw new Error(`没有这条收件箱条目: ${id}`)
    return this.enqueue(() => appendRecord(this.store, 'inbox', { op: action, itemId: id, at: this.now() }))
  }

  // ── 派发与投递 ────────────────────────────────────────────────────────

  async addJob(job) {
    const at = this.now()
    await this.enqueue(() => appendRecord(this.store, 'jobs', { op: 'create', job: { ...job, createdAt: at } }))
    return job
  }

  async updateJob(jobId, patch) {
    await this.enqueue(() => appendRecord(this.store, 'jobs', { op: 'update', jobId, patch, at: this.now() }))
    return this.state.jobs.get(jobId)
  }

  listJobs() {
    return [...this.state.jobs.values()]
  }

  /**
   * 投递一条 note。kind=preview 时同时进收件箱；同一开环只保留一条待读，
   * 后来的把前一条标 superseded（SPEC §3.3）。
   */
  async deliverNote(input, { blocking = false } = {}) {
    const note = makeNote({
      id: `D-${this.state.counters.note + 1}`,
      epoch: this.state.epoch,
      at: this.now(),
      ...input,
    })
    const errors = validateNote(note)
    if (errors.length > 0) throw new Error(`note 不成立：${errors.join('；')}`)
    await this.enqueue(() => appendRecord(this.store, 'notes', note))
    if (note.kind !== 'preview') return note

    const loopId = Array.isArray(note.loops) && note.loops.length > 0 ? note.loops[0] : null
    for (const item of [...this.state.inbox.values()]) {
      if (loopId !== null && item.loopId === loopId && (item.status === 'unread' || item.status === 'deferred')) {
        await this.enqueue(() => appendRecord(this.store, 'inbox', { op: 'supersede', itemId: item.id, at: this.now() }))
      }
    }
    await this.enqueue(() =>
      appendRecord(this.store, 'inbox', {
        op: 'deliver',
        item: makeItem({
          id: `I-${this.state.counters.inbox + 1}`,
          noteId: note.id,
          loopId,
          epoch: note.epoch,
          claim: note.claim,
          question: note.question,
          blocking,
          at: this.now(),
        }),
      }),
    )
    return note
  }

  // ── 交接简报与跨天恢复（SPEC §5.3 / §5.5） ──────────────────────────

  latestBriefing() {
    return this.state.briefings.length === 0 ? null : this.state.briefings[this.state.briefings.length - 1]
  }

  briefingMaterials() {
    const loops = this.listLoops()
    const running = [...this.state.jobs.values()].filter((job) => job.state === 'running' || job.state === 'timeout')
    return {
      activeLoops: loops
        .filter((loop) => loop.status === 'active')
        .map((loop) => ({ id: loop.id, text: loop.text, closureCondition: loop.closureCondition })),
      dormant: loops.filter((loop) => loop.status === 'dormant').length,
      running: running.map((job) => ({ id: job.id, label: job.label, state: job.state })),
      drafts: [],
      inboxPending: this.inboxView({ all: true }).previews.length,
    }
  }

  /** Mind 自己写简报；Ink 只存。五段：推进/开环/在跑/草稿/下步（SPEC §5.3）。 */
  async saveBriefing(input) {
    const fields = {}
    for (const key of ['progress', 'loops', 'running', 'drafts', 'next']) {
      fields[key] = String(input?.[key] ?? '').trim()
    }
    if (fields.progress === '' && fields.next === '') {
      throw new Error('简报至少要有"推进"或"下步"，否则明天的你会认不出自己')
    }
    const record = { day: dayOf(this.now()), at: this.now(), ...fields }
    await this.enqueue(() => appendRecord(this.store, 'briefings', record))
    return record
  }

  status() {
    const loops = this.listLoops()
    const view = this.inboxView({ all: true })
    return {
      session: this.sessionId,
      turn: this.turn,
      epoch: this.state.epoch,
      day: dayOf(this.now()),
      observations: this.state.counters.obs,
      loops: {
        active: loops.filter((loop) => loop.status === 'active').length,
        dormant: loops.filter((loop) => loop.status === 'dormant').length,
        folded: loops.filter((loop) => loop.status === 'folded').length,
        closed: loops.filter((loop) => loop.status === 'closed').length,
        cap: ACTIVE_LOOP_CAP,
        aging: { dormantAfterDays: DORMANT_AFTER_DAYS, foldedAfterDays: FOLDED_AFTER_DAYS },
      },
      facts: {
        active: this.listFacts().length,
        stale: [...this.state.facts.values()].filter((fact) => fact.stale).length,
      },
      inbox: { pending: view.previews.length + view.hiddenCount, byTier: view.byTier },
      notes: this.state.notes.length,
    }
  }

  /** L3：Mind 每轮看见的后台摘要。空着就返回空串（不制造噪音）。 */
  l3Text() {
    const loops = activeLoops(this.listLoops())
    const dormant = this.listLoops().filter((loop) => loop.status === 'dormant').length
    const view = this.inboxView({ all: false })

    const lines = []
    const briefing = this.latestBriefing()
    const today = dayOf(this.now())
    if (briefing !== null && briefing.day < today) {
      lines.push(`## 交接简报（${briefing.day} 写的，今天是 ${today}——开工先看这个）`)
      if (briefing.progress) lines.push(`推进：${briefing.progress}`)
      if (briefing.loops) lines.push(`开环：${briefing.loops}`)
      if (briefing.running) lines.push(`在跑：${briefing.running}`)
      if (briefing.drafts) lines.push(`草稿：${briefing.drafts}`)
      if (briefing.next) lines.push(`下步（你昨天想的）：${briefing.next}`)
      lines.push('')
    }
    if (loops.length === 0 && view.previews.length === 0 && lines.length === 0) return ''
    lines.push('## 后台（Ink）')
    if (loops.length > 0) {
      lines.push(`悬着的事：活跃 ${loops.length} / 休眠 ${dormant}（上限 ${ACTIVE_LOOP_CAP}）`)
      for (const loop of loops.slice(0, 5)) {
        const condition = loop.closureCondition === null ? '' : `｜闭合条件：${loop.closureCondition}`
        lines.push(`- [${loop.id}] ${loop.text}${condition}`)
      }
      if (loops.length > 5) lines.push(`- …还有 ${loops.length - 5} 条活跃开环`)
    }
    if (view.previews.length > 0) {
      lines.push(`收件箱待读 ${view.previews.length + view.hiddenCount} 条：`)
      for (const entry of view.previews) {
        const loop = entry.item.loopId === null ? '' : `（${entry.item.loopId}）`
        lines.push(`- [${['T0', 'T1', 'T2', 'T3'][entry.tier]}] ${entry.item.claim}${loop}`)
      }
      if (view.hiddenCount > 0) lines.push(`- …还有 ${view.hiddenCount} 条未显示`)
    }
    lines.push('注：开环只由你闭合；Ink 只提示。这张表用户看不到。')
    return lines.slice(0, MAX_L3_LINES).join('\n')
  }
}
