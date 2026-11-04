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
import { makeCase, matchCase, matchFacts } from './cases.js'
import { describeBranches, makeBranch } from './branches.js'
import { appendRecord } from './store.js'

export const INK_TOOL_NAMES = Object.freeze(['ink_status', 'ink_loops', 'ink_facts', 'ink_inbox', 'ink_dispatch', 'ink_commit', 'ink_brief', 'ink_epoch', 'ink_draft', 'ink_branch'])

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
    const last = store.state.observations[store.state.observations.length - 1]
    this.lastTurnDay = last !== undefined && Number.isFinite(last.day) ? last.day : null
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
      } else if (type === 'tool/result') {
        const name = String(event.data?.message?.source?.toolName ?? event.data?.meta?.name ?? 'tool')
        const text = textOf(event.data?.message?.content).slice(0, 240)
        const isError = event.data?.message?.isError === true
        this.enqueue(() => this.recordObservation('tool', `${name}${isError ? ' [error]' : ''}: ${text}`, this.turn))
      } else if (type === 'compaction/summary') {
        this.enqueue(() => this.recordObservation('fold', '叙事被折叠（compaction）', this.turn))
      }
    } catch {
      // 观测层不允许把会话弄挂：单条事件解析失败就放弃这一条。
    }
  }

  async recordObservation(kind, text, turn) {
    const seq = this.state.counters.obs + 1
    const day = dayOf(this.now())
    this.lastTurnDay = this.lastTurnDay === null ? day : Math.max(this.lastTurnDay, day)
    await appendRecord(this.store, 'observations', {
      seq,
      at: this.now(),
      day,
      turn,
      kind,
      epoch: this.state.epoch,
      text: text.length > 200_000 ? `${text.slice(0, 200_000)}…[truncated]` : text,
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

    await this.expireDrafts({ today })

    if (this.lastTurnDay !== null && today > this.lastTurnDay) {
      const covered = this.state.briefings.some(
        (record) => record.day === this.lastTurnDay && (record.kind === undefined || record.kind === 'auto-materials'),
      )
      if (!covered) await this.foldDay(this.lastTurnDay)
    }
    this.lastTurnDay = this.lastTurnDay === null ? today : Math.max(this.lastTurnDay, today)

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

  /** 三区视图：unread（默认待读）/ history（已读、压后台、被合并）/ starred（星标）。 */
  inboxZone(zone) {
    const items = [...this.state.inbox.values()]
    if (zone === 'starred') {
      return items.filter((item) => item.status === 'starred').sort((a, b) => b.createdAt - a.createdAt)
    }
    if (zone === 'history') {
      return items
        .filter((item) => item.status === 'read' || item.status === 'deferred' || item.status === 'superseded')
        .sort((a, b) => b.createdAt - a.createdAt)
    }
    return this.inboxView({ all: true }).previews.map((entry) => entry.item)
  }

  /** 展开一条收件箱条目：从账本取回它的 note（brief + detail）。 */
  openInboxItem(id) {
    const item = this.state.inbox.get(id)
    if (item === undefined) throw new Error(`没有这条收件箱条目: ${id}`)
    const note = item.noteId === null ? undefined : this.state.notes.find((entry) => entry.id === item.noteId)
    return { item, note: note ?? null }
  }

  markInbox(id, action) {
    if (!this.state.inbox.has(id)) throw new Error(`没有这条收件箱条目: ${id}`)
    return this.enqueue(() => appendRecord(this.store, 'inbox', { op: action, itemId: id, at: this.now() }))
  }

  // ── 派发与投递 ────────────────────────────────────────────────────────

  async addJob(job) {
    const at = this.now()
    await this.enqueue(() => appendRecord(this.store, 'jobs', { op: 'create', job: { ...job, createdAt: at } }))
    // 任务属于哪条分支，在创建时就定下来：鱼骨的肋骨不是后挂的。
    if (typeof job?.branchId === 'string' && this.state.branches.has(job.branchId)) {
      await this.attachJobToBranch(job.branchId, job.id)
    }
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
    const deliverable = note.kind === 'preview' || (blocking && note.kind === 'hold')
    if (!deliverable) return note

    const loopId =
      note.kind === 'preview' && Array.isArray(note.loops) && note.loops.length > 0 ? note.loops[0] : null
    const branchId = note.kind === 'preview' && typeof note.branch === 'string' ? note.branch : null
    for (const item of [...this.state.inbox.values()]) {
      const sameAnchor =
        (loopId !== null && item.loopId === loopId) ||
        (loopId === null && branchId !== null && item.branchId === branchId)
      if (sameAnchor && (item.status === 'unread' || item.status === 'deferred')) {
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
          branchId,
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

  /** 最近一份「主体」简报；隔夜更新与盘外素材都不算主体（SPEC §5.3）。 */
  latestBriefing() {
    for (let index = this.state.briefings.length - 1; index >= 0; index -= 1) {
      const record = this.state.briefings[index]
      if (record.kind === undefined || record.kind === null) return record
    }
    return null
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
      drafts: this.listDrafts().map((draft) => ({ id: draft.id, title: draft.title, conf: draft.conf })),
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
    const total = fields.progress.length + fields.loops.length + fields.running.length + fields.drafts.length + fields.next.length
    if (total > 1800) throw new Error(`简报超过一屏（${total} 字 > 1800），重新折一次再写`)
    const record = { day: dayOf(this.now()), at: this.now(), ...fields }
    await this.enqueue(() => appendRecord(this.store, 'briefings', record))
    return record
  }

  /** 话题 epoch 由 Mind 判定（SPEC §4.6）；Ink 只负责记账与过期标记。 */
  async advanceEpoch({ note = null } = {}) {
    const next = this.state.epoch + 1
    const seq = this.state.counters.obs + 1
    await this.enqueue(() =>
      appendRecord(this.store, 'observations', {
        seq,
        at: this.now(),
        day: dayOf(this.now()),
        turn: this.turn,
        kind: 'epoch',
        epoch: next,
        text: note === null ? `话题 epoch → ${next}` : `话题 epoch → ${next}：${String(note).slice(0, 200)}`,
      }),
    )
    this.state.counters.obs = seq
    return { epoch: next }
  }

  /** 给客户端的后台快照（session projection 的 wire view 用）。只放指针与短文本。 */
  backstageSnapshot() {
    const loops = this.listLoops()
    const facts = this.listFacts()
    const view = this.inboxView({ all: false })
    const running = [...this.state.jobs.values()].filter((job) => job.state === 'running')
    return {
      epoch: this.state.epoch,
      day: dayOf(this.now()),
      loops: {
        active: loops
          .filter((loop) => loop.status === 'active')
          .slice(0, 8)
          .map((loop) => ({ id: loop.id, text: loop.text, type: loop.type })),
        activeCount: loops.filter((loop) => loop.status === 'active').length,
        dormant: loops.filter((loop) => loop.status === 'dormant').length,
        closed: loops.filter((loop) => loop.status === 'closed' || loop.status === 'dropped').length,
      },
      facts: {
        active: facts.length,
        items: facts.slice(0, 8).map((fact) => ({ id: fact.id, claim: fact.claim, conf: fact.conf, source: fact.source })),
      },
      inbox: {
        pending: view.previews.length + view.hiddenCount,
        previews: view.previews.map((entry) => ({
          id: entry.item.id,
          tier: ['T0', 'T1', 'T2', 'T3'][entry.tier],
          claim: entry.item.claim,
          question: entry.item.question,
        })),
      },
      jobs: { running: running.length, items: running.slice(0, 5).map((job) => ({ id: job.id, label: job.label })) },
      drafts: {
        open: this.listDrafts().length,
        items: this.listDrafts().slice(0, 5).map((draft) => ({ id: draft.id, title: draft.title, conf: draft.conf })),
      },
      branches: {
        open: this.listBranches().length,
        items: this.listBranches()
          .slice(0, 5)
          .map((branch) => ({
            id: branch.id,
            label: branch.label,
            summary: branch.summary,
            jobs: branch.jobs.length,
            forkedAtTurn: branch.forkedAtTurn,
          })),
      },
      audit: {
        notes: this.state.notes
          .slice(-8)
          .reverse()
          .map((note) => ({ id: note.id, kind: note.kind, claim: note.claim })),
      },
    }
  }

  // ── 草稿区（SPEC §2.5 / §4.1） ──────────────────────────────────────

  async addDraft(input) {
    const title = String(input?.title ?? '').trim()
    if (title === '') throw new Error('草稿至少要有标题')
    const at = this.now()
    const draft = {
      id: `P-${this.state.counters.draft + 1}`,
      title,
      summary: String(input?.summary ?? '').trim(),
      artifact: input?.artifact ?? null,
      conf: ['low', 'mid', 'high'].includes(input?.conf) ? input.conf : 'mid',
      source: input?.source ?? 'mind',
      status: 'open',
      createdAt: at,
      createdDay: dayOf(at),
      settledAt: null,
    }
    await this.enqueue(() => appendRecord(this.store, 'drafts', { op: 'create', draft }))
    return draft
  }

  listDrafts({ includeSettled = false } = {}) {
    const all = [...this.state.drafts.values()].sort((a, b) => b.createdAt - a.createdAt)
    return includeSettled ? all : all.filter((draft) => draft.status === 'open')
  }

  async settleDraft(id, { status, reason = null } = {}) {
    if (!this.state.drafts.has(id)) throw new Error(`没有这张草稿: ${id}`)
    if (!['committed', 'rejected', 'expired', 'dropped'].includes(status)) throw new Error(`未知草稿状态: ${status}`)
    await this.enqueue(() =>
      appendRecord(this.store, 'drafts', {
        op: 'update',
        draftId: id,
        patch: { status, settledAt: this.now(), settleReason: reason },
        at: this.now(),
      }),
    )
    return this.state.drafts.get(id)
  }

  /** 草稿天轴老化：一周没碰自动丢（SPEC §5.6）。返回被丢的 id。 */
  async expireDrafts({ today } = {}) {
    const day = today ?? dayOf(this.now())
    const expired = []
    for (const draft of this.state.drafts.values()) {
      if (draft.status !== 'open') continue
      if (day - draft.createdDay >= 7) {
        await this.settleDraft(draft.id, { status: 'expired', reason: 'aging:7d' })
        expired.push(draft.id)
      }
    }
    return expired
  }

  // ── 交接简报：单屏校验与隔夜追加（SPEC §5.3） ────────────────────────

  /** 隔夜更新：追加一条，不覆盖原句（SPEC §5.3）。 */
  async appendBriefingUpdate(text) {
    const value = String(text ?? '').trim()
    if (value === '') throw new Error('隔夜更新不能为空')
    const briefing = this.latestBriefing()
    if (briefing === null) throw new Error('还没有任何交接简报，先写一份主体再追加更新')
    const record = { kind: 'overnight', day: dayOf(this.now()), at: this.now(), text: value, afterBriefingAt: briefing.at }
    await this.enqueue(() => appendRecord(this.store, 'briefings', record))
    return record
  }

  // ── Operator 问答与判例（SPEC §2.4 / §3.2 / §3.3） ─────────────────

  async recordCase({ question, answer, citations, at }) {
    const entry = makeCase({
      id: `C-${this.state.counters.case + 1}`,
      question,
      answer,
      citations,
      at: at ?? this.now(),
    })
    await this.enqueue(() => appendRecord(this.store, 'cases', entry))
    return entry
  }

  listCases() {
    return [...this.state.cases].reverse()
  }

  /**
   * Operator 提问的唯一通道：能引用就自答（判例优先，其次事实卡），
   * 要发明就上报（blocking 预览进 Mind 收件箱）并让 Operator 按契约继续。
   */
  async answerOperatorQuestion({ question, childId = null }) {
    const query = String(question ?? '').trim()
    if (query === '') throw new Error('问题不能为空')
    const job =
      childId === null
        ? undefined
        : [...this.state.jobs.values()].find((entry) => String(entry.childId) === String(childId))
    const jobRefs = job === undefined ? [] : [job.id]

    const caseHit = matchCase(query, this.state.cases)
    if (caseHit !== null) {
      const citations = [...caseHit.case.citations]
      await this.deliverNote({
        kind: 'answer',
        claim: `答复 Operator（引判例 ${caseHit.case.id}）：${caseHit.case.answer.slice(0, 60)}`,
        why: 'cite:case',
        refs: [...citations, caseHit.case.id, ...jobRefs],
        conf: 'mid',
        detail: `问题：${query}\n回答：${caseHit.case.answer}\n判例：${caseHit.case.id}`,
      })
      return {
        kind: 'answer',
        answer: caseHit.case.answer,
        citations,
        source: 'precedent',
        caseId: caseHit.case.id,
        score: Number(caseHit.score.toFixed(2)),
      }
    }

    const factHit = matchFacts(query, activeFacts(this.state.facts))
    if (factHit !== null) {
      const citations = [factHit.fact.id]
      const record = await this.recordCase({ question: query, answer: factHit.fact.claim, citations })
      await this.deliverNote({
        kind: 'answer',
        claim: `答复 Operator（引 ${citations.join('、')}）：${factHit.fact.claim.slice(0, 50)}`,
        why: 'cite:fact',
        refs: [...citations, record.id, ...jobRefs],
        conf: factHit.fact.conf,
        detail: `问题：${query}\n回答：${factHit.fact.claim}\n判例：${record.id}`,
      })
      return {
        kind: 'answer',
        answer: factHit.fact.claim,
        citations,
        source: 'fact',
        caseId: record.id,
        score: Number(factHit.score.toFixed(2)),
      }
    }

    // 不能自答的挂起，不猜（SPEC §5.4）：blocking 预览进收件箱，Operator 继续。
    await this.deliverNote(
      {
        kind: 'hold',
        claim: `后台问了一件事，我手上没有可引用的答案`,
        why: 'no-citation',
        refs: jobRefs,
        conf: 'low',
        question: `要不要现在定一下：${query.slice(0, 60)}`,
        detail: `Operator 原问题（不直接进对话）：${query}`,
      },
      { blocking: true },
    )
    return {
      kind: 'escalated',
      answer: null,
      reason: 'no-citation',
      message: 'Ink 无法凭引用回答，已上报 Mind；按契约里最接近的读法继续，并在最终报告里注明这一处假设。',
    }
  }

  /** Mind 最近对用户说过的话（首行，供编译时检测矛盾）。 */
  recentUtterances(limit = 8) {
    return this.state.observations
      .filter((entry) => entry.kind === 'assistant')
      .slice(-limit)
      .map((entry) => {
        const firstLine = String(entry.text ?? '')
          .split('\n')
          .map((line) => line.trim())
          .find((line) => line !== '')
        return (firstLine ?? '').slice(0, 160)
      })
      .filter((line) => line !== '')
  }

  /**
   * 硬断事后折叠（SPEC §5.2）：把「停在哪天」整理成盘外素材，
   * 不代写简报、不写对话——Mind 下次开工先承认断点，再用这些素材重建。
   */
  async foldDay(day) {
    const assistants = this.state.observations.filter((entry) => entry.kind === 'assistant' && entry.day === day)
    const progress = assistants
      .slice(-3)
      .map((entry) => String(entry.text ?? '').split('\n')[0].slice(0, 80))
      .filter((line) => line !== '')
      .join(' / ')
    const loopLines = this.listLoops()
      .filter((loop) => loop.status === 'active')
      .slice(0, 5)
      .map((loop) => `${loop.id} ${loop.text}`)
      .join('；')
    const running = [...this.state.jobs.values()]
      .filter((job) => job.state === 'running')
      .map((job) => `${job.id} ${job.label}`)
      .join('；')
    const drafts = this.listDrafts()
      .map((draft) => `${draft.id} ${draft.title}`)
      .join('；')
    const record = {
      kind: 'auto-materials',
      day,
      at: this.now(),
      progress,
      loops: loopLines,
      running,
      drafts,
      next: null,
    }
    await this.enqueue(() => appendRecord(this.store, 'briefings', record))
    return record
  }

  /**
   * 跨天断点检测（SPEC §5.2）：上次真人对话停在旧的一天、且那天没有收工简报时，
   * 整理盘外素材并记一条 hard-break；L3 在当天持续提醒，直到 Mind 写了新简报。
   */
  async detectGap() {
    const today = dayOf(this.now())
    const human = this.state.observations.filter(
      (entry) => entry.kind === 'user' || entry.kind === 'assistant',
    )
    const last = human[human.length - 1]
    if (last === undefined || !Number.isFinite(last.day) || today <= last.day) return null
    const covered = this.state.briefings.some(
      (record) => record.day === last.day && (record.kind === undefined || record.kind === null),
    )
    if (covered) return null
    const already = this.state.briefings.some(
      (record) => record.kind === 'hard-break' && record.day === last.day,
    )
    if (already) return null
    const materials = this.state.briefings.some(
      (record) => record.kind === 'auto-materials' && record.day === last.day,
    )
    if (!materials) await this.foldDay(last.day)
    const record = { kind: 'hard-break', day: last.day, detectedDay: today, at: this.now() }
    await this.enqueue(() => appendRecord(this.store, 'briefings', record))
    return record
  }

  /**
   * 对话节奏（SPEC §4.5）：只给可见信号，不给阈值、不给建议。
   * Mind 自己判断现在是不是话题间隙；Ink 不替它决定要不要说。
   */
  conversationRhythm() {
    const humans = this.state.observations.filter(
      (entry) => entry.kind === 'user' || entry.kind === 'assistant',
    )
    if (humans.length < 2) return null
    const recentUsers = this.state.observations.filter((entry) => entry.kind === 'user').slice(-3)
    if (recentUsers.length === 0) return null

    const lengths = recentUsers.map((entry) => String(entry.text ?? '').trim().length)
    const confirming = /^(嗯+|对|是的|可以|好|行|确实|没错|ok|okay)[。！!\s]*$/iu
    const confirmCount = recentUsers.filter((entry) => confirming.test(String(entry.text ?? '').trim())).length
    const last = humans[humans.length - 1]
    const minutes = last === undefined ? null : Math.max(0, Math.round((this.now() - last.at) / 60000))

    const parts = [`最近三条你说的话：${lengths.map((n) => `${n} 字`).join(' / ')}`]
    if (confirmCount > 0) parts.push(`其中 ${confirmCount} 条是确认型回复`)
    if (minutes !== null && minutes >= 3) parts.push(`距上一句 ${minutes} 分钟`)
    const active = this.listLoops().filter((loop) => loop.status === 'active')
    if (active.length === 0) parts.push('没有活跃开环在推进')
    return parts.join('；')
  }

  // ── 鱼骨：分支（SPEC §1.3 / §4.6） ───────────────────────────────────

  /**
   * 从对话的当前节点开一条分支。forkedAtTurn 是「对话的哪一轮」，
   * 这就是鱼骨的分叉点：分支不是凭空出现的，它总连着一句话。
   */
  async openBranch({ label, summary = '', forkedAtTurn = null }) {
    const text = String(label ?? '').trim()
    if (text === '') throw new Error('分支要有个名字')
    const branch = makeBranch({
      id: `B-${this.state.counters.branch + 1}`,
      label: text,
      summary,
      forkedAtTurn: forkedAtTurn ?? this.turn,
      forkedAtSeq: this.state.counters.obs,
      at: this.now(),
    })
    await this.enqueue(() => appendRecord(this.store, 'branches', { op: 'create', branch }))
    return branch
  }

  listBranches({ includeSettled = false } = {}) {
    const all = [...this.state.branches.values()].sort((a, b) => b.createdAt - a.createdAt)
    return includeSettled ? all : all.filter((branch) => branch.status === 'open')
  }

  async updateBranchSummary(id, summary) {
    if (!this.state.branches.has(id)) throw new Error(`没有这条分支: ${id}`)
    await this.enqueue(() =>
      appendRecord(this.store, 'branches', { op: 'summary', branchId: id, summary: String(summary ?? '').trim(), at: this.now() }),
    )
    return this.state.branches.get(id)
  }

  async attachJobToBranch(branchId, jobId) {
    if (!this.state.branches.has(branchId)) throw new Error(`没有这条分支: ${branchId}`)
    await this.enqueue(() => appendRecord(this.store, 'branches', { op: 'attach-job', branchId, jobId, at: this.now() }))
    return this.state.branches.get(branchId)
  }

  /** 汇回主干：分支的结论变成一条带指针的 note，进收件箱（不是塞进对话）。 */
  async mergeBranch(id, { claim, detail = null, loops = [] } = {}) {
    const branch = this.state.branches.get(id)
    if (branch === undefined) throw new Error(`没有这条分支: ${id}`)
    const note = await this.deliverNote({
      kind: 'preview',
      claim: String(claim ?? '').trim() || `${branch.label} 有结论了`,
      why: 'branch:merge',
      refs: [id, ...branch.jobs],
      loops,
      question: `要不要把「${branch.label}」的结论接回刚才那条线？`,
      conf: 'mid',
      detail,
      branch: id,
      newConclusion: true,
    })
    await this.enqueue(() =>
      appendRecord(this.store, 'branches', { op: 'merge', branchId: id, mergedInto: note.id, at: this.now() }),
    )
    return { branch: this.state.branches.get(id), note }
  }

  async abandonBranch(id, { reason = null } = {}) {
    if (!this.state.branches.has(id)) throw new Error(`没有这条分支: ${id}`)
    await this.enqueue(() =>
      appendRecord(this.store, 'branches', { op: 'abandon', branchId: id, at: this.now(), reason }),
    )
    return this.state.branches.get(id)
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
    const hardBreak = [...this.state.briefings]
      .reverse()
      .find((record) => record.kind === 'hard-break' && record.detectedDay === today)
    if (hardBreak !== undefined) {
      lines.push(`## 上次对话停在第 ${hardBreak.day} 天，没有收工简报——先承认断点，再继续（SPEC §5.2）`)
      const materials = [...this.state.briefings]
        .reverse()
        .find((record) => record.kind === 'auto-materials' && record.day === hardBreak.day)
      if (materials !== undefined) {
        if (materials.progress) lines.push(`盘外素材·推进：${materials.progress}`)
        if (materials.loops) lines.push(`盘外素材·悬着：${materials.loops}`)
        if (materials.running) lines.push(`盘外素材·在跑：${materials.running}`)
        if (materials.drafts) lines.push(`盘外素材·草稿：${materials.drafts}`)
        lines.push('注：这是 Ink 整理的素材，不是你写的简报；开工时按自己的话重建。')
      }
      lines.push('')
    } else if (briefing !== null && briefing.day < today) {
      lines.push(`## 交接简报（${briefing.day} 写的，今天是 ${today}——开工先看这个）`)
      if (briefing.progress) lines.push(`推进：${briefing.progress}`)
      if (briefing.loops) lines.push(`开环：${briefing.loops}`)
      if (briefing.running) lines.push(`在跑：${briefing.running}`)
      if (briefing.drafts) lines.push(`草稿：${briefing.drafts}`)
      if (briefing.next) lines.push(`下步（你昨天想的）：${briefing.next}`)
      const updates = this.state.briefings.filter(
        (record) => record.kind === 'overnight' && record.afterBriefingAt === briefing.at,
      )
      for (const update of updates) lines.push(`隔夜更新：${update.text}`)
      lines.push('')
    } else {
      const lastObserved = this.state.observations[this.state.observations.length - 1]
      const lastDay = lastObserved !== undefined && Number.isFinite(lastObserved.day) ? lastObserved.day : today
      if (today - lastDay >= 1) {
        lines.push(`## 上次对话停在第 ${lastDay} 天，没有收工简报——先承认断点，再继续（SPEC §5.2）`)
        const materials = [...this.state.briefings]
          .reverse()
          .find((record) => record.kind === 'auto-materials' && record.day === lastDay)
        if (materials !== undefined) {
          if (materials.progress) lines.push(`盘外素材·推进：${materials.progress}`)
          if (materials.loops) lines.push(`盘外素材·悬着：${materials.loops}`)
          if (materials.running) lines.push(`盘外素材·在跑：${materials.running}`)
          if (materials.drafts) lines.push(`盘外素材·草稿：${materials.drafts}`)
          lines.push('注：这是 Ink 整理的素材，不是你写的简报；开工时按自己的话重建。')
        }
        lines.push('')
      }
    }
    const openBranchCount = this.listBranches().length
    if (loops.length === 0 && view.previews.length === 0 && openBranchCount === 0 && lines.length === 0) return ''
    lines.push('## 后台（Ink）')
    if (view.previews.length > 0) {
      lines.push(`收件箱待读 ${view.previews.length + view.hiddenCount} 条：`)
      for (const entry of view.previews) {
        const loop = entry.item.loopId === null ? '' : `（${entry.item.loopId}）`
        const question = entry.item.question === null ? '' : ` → ${entry.item.question}`
        lines.push(`- [${['T0', 'T1', 'T2', 'T3'][entry.tier]}] ${entry.item.claim}${loop}${question}`)
      }
      if (view.hiddenCount > 0) lines.push(`- …还有 ${view.hiddenCount} 条未显示`)
      // 有东西可展示时才给节奏：Ink 不规定时机，只让 Mind 看得见（SPEC §4.5）。
      const rhythm = this.conversationRhythm()
      if (rhythm !== null) lines.push(`节奏：${rhythm}`)
    }
    if (loops.length > 0) {
      lines.push(`悬着的事：活跃 ${loops.length} / 休眠 ${dormant}（上限 ${ACTIVE_LOOP_CAP}）`)
      for (const loop of loops.slice(0, 5)) {
        const condition = loop.closureCondition === null ? '' : `｜闭合条件：${loop.closureCondition}`
        lines.push(`- [${loop.id}] ${loop.text}${condition}`)
      }
      if (loops.length > 5) lines.push(`- …还有 ${loops.length - 5} 条活跃开环`)
    }
    const branchLines = describeBranches(
      [...this.state.branches.values()],
      [...this.state.jobs.values()],
    )
    if (branchLines.length > 0) {
      lines.push('鱼骨分支：')
      for (const line of branchLines) lines.push(`- ${line}`)
    }
    return lines.slice(0, MAX_L3_LINES).join('\n')
  }
}
