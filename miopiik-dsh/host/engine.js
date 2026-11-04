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
import { makeCase, matchCase, matchFacts, similarity } from './cases.js'
import { buildArchive, makeProposal, settlementDraft, verifyProposal } from './fold.js'
import { DEFAULTS } from './config-defaults.js'
import { gcDetails, putDetail, readDetail, searchIndex, extractEntities } from './details.js'
import { describeBranches, makeBranch, renderBranchSlice } from './branches.js'
import { appendRecord, appendSharedFact, applyRecord, readSharedFactsSince } from './store.js'

/** 工具返回值必须是无损 JSON：去掉 undefined 之类的不可序列化字段。 */
export function lossless(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return null
  }
}

export const INK_TOOL_NAMES = Object.freeze(['ink_status', 'ink_loops', 'ink_facts', 'ink_inbox', 'ink_dispatch', 'ink_commit', 'ink_brief', 'ink_epoch', 'ink_draft', 'ink_branch', 'ink_fold', 'ink_recall'])

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
    this.shared = store.shared ?? null
    this.stateDir = store.dir
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
        // 轮次必须在「到达时」取，不能等到写入时再读 this.turn——否则同一批入队的消息会共用最后的轮次。
        const turn = this.turn
        if (text !== '') this.enqueue(() => this.recordObservation('user', text, turn))
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
  /** 收工信号（SPEC §5.2）：只认明显在道别的话，不去猜「他是不是要走」。 */
  static FAREWELL = /(先这样|先到这里|今天就到这儿?|明天再(说|聊|继续)|下次再聊|我去忙|我去睡|晚安|回头聊|拜拜|bye[- ]?bye|good ?night)/iu

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

    // 收工信号：Ink 不替 Mind 写简报，只让它在下一轮看得见「用户刚才像在道别」。
    const lastUser = [...this.state.observations].reverse().find((entry) => entry.kind === 'user')
    if (lastUser !== undefined && Engine.FAREWELL.test(String(lastUser.text ?? ''))) {
      await this.enqueue(() =>
        appendRecord(this.store, 'briefings', {
          kind: 'closing-signal',
          day: today,
          at: now,
          turn,
          quote: String(lastUser.text ?? '').slice(0, 120),
        }),
      )
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
    await this.enqueue(async () => {
      const record = { op: 'add', fact: { ...fact, scope: 'workspace' } }
      if (this.shared === null) await appendRecord(this.store, 'facts', record)
      else await appendSharedFact(this.shared, record)
      // 本会话视图同步（否则刚写的事实要重启才可见）；用 applyRecord 才能顺带推进计数器。
      if (this.shared !== null) applyRecord(this.state, 'facts', record)
    })
    return fact
  }

  async reviseFact(id, patch) {
    if (!this.state.facts.has(id)) throw new Error(`没有这张事实卡: ${id}`)
    await this.enqueue(async () => {
      const record = { op: 'revise', factId: id, patch, at: this.now() }
      if (this.shared === null) await appendRecord(this.store, 'facts', record)
      else {
        await appendSharedFact(this.shared, record)
        applyRecord(this.state, 'facts', record) // 本会话视图同步，别让刚改的结论看不见
      }
    })
    return this.state.facts.get(id)
  }

  async invalidateFact(id, reason) {
    if (!this.state.facts.has(id)) throw new Error(`没有这张事实卡: ${id}`)
    await this.enqueue(async () => {
      const record = { op: 'invalidate', factId: id, at: this.now(), reason }
      if (this.shared === null) await appendRecord(this.store, 'facts', record)
      else {
        await appendSharedFact(this.shared, record)
        applyRecord(this.state, 'facts', record)
      }
    })
    return this.state.facts.get(id)
  }

  listFacts() {
    // 别的窗口刚写的事实，这里补读一次就能看见（不需要重开会话）。
    for (const record of readSharedFactsSince(this.shared)) applyRecord(this.state, 'facts', record)
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
  async openInboxItem(id) {
    const item = this.state.inbox.get(id)
    if (item === undefined) throw new Error(`没有这条收件箱条目: ${id}`)
    const note = item.noteId === null ? undefined : this.state.notes.find((entry) => entry.id === item.noteId)
    const detailRef = note?.detailRef ?? null
    // 指针指向详情仓时按需读回；短详情仍内联在 note 里，原样返回。
    const detail = detailRef === null ? (note?.detail ?? null) : await this.readDetailText(detailRef)
    return { item, note: note ?? null, detailRef, detail }
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
    // 长详情不进账本正文：先落详情仓，note 只留指针（SPEC §2.2「账本是数据，上下文只是索引」）。
    let payload = input
    if (typeof input?.detail === 'string' && input.detail.length > DEFAULTS.detailInlineMaxChars) {
      const entry = await this.storeDetail({
        text: input.detail,
        kind: 'note-detail',
        refs: input.refs ?? [],
        loops: input.loops ?? [],
        branch: input.branch ?? null,
        jobId: input.jobId ?? null,
      })
      payload = { ...input, detail: entry.preview, detailRef: entry.hash }
    }
    const note = makeNote({
      id: `D-${this.state.counters.note + 1}`,
      epoch: this.state.epoch,
      at: this.now(),
      ...payload,
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
    if (total > DEFAULTS.briefingMaxChars) {
      throw new Error(`简报超过一屏（${total} 字 > ${DEFAULTS.briefingMaxChars}），重新折一次再写`)
    }
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
      letter: (() => {
        const briefing = this.latestBriefing()
        if (briefing === null) return null
        const updates = this.state.briefings.filter(
          (record) => record.kind === 'overnight' && record.afterBriefingAt === briefing.at,
        )
        return {
          day: briefing.day,
          progress: briefing.progress ?? '',
          loops: briefing.loops ?? '',
          running: briefing.running ?? '',
          drafts: briefing.drafts ?? '',
          next: briefing.next ?? '',
          updates: updates.map((update) => ({ at: update.at, text: update.text })),
        }
      })(),
      drafts: {
        open: this.listDrafts().length,
        items: this.listDrafts().slice(0, 5).map((draft) => ({ id: draft.id, title: draft.title, conf: draft.conf })),
      },
      /**
       * 鱼骨图的原始数据（客户端只做布局，不做语义判断）：
       * 主干 = 有用户发言的轮次；分支 = 分叉点、任务、汇回点。
       */
      graph: (() => {
        // 按事件建模：只有分叉、汇回、任务落点产生节点（不按轮次铺格子）。
        const branches = [...this.state.branches.values()].sort((a, b) => a.createdAt - b.createdAt)
        const noteById = new Map(this.state.notes.map((note) => [note.id, note]))
        const events = []
        const nodes = branches.map((branch) => {
          const jobs = branch.jobs.map((jobId) => this.state.jobs.get(jobId)).filter((job) => job !== undefined)
          events.push({ id: `fork:${branch.id}`, kind: 'fork', at: branch.createdAt, branchId: branch.id, turn: branch.forkedAtTurn ?? null })
          if (branch.status === 'merged' || branch.status === 'abandoned') {
            events.push({
              id: `merge:${branch.id}`,
              kind: branch.status === 'merged' ? 'merge' : 'abandon',
              at: branch.settledAt ?? branch.updatedAt,
              branchId: branch.id,
              turn: branch.mergedAtTurn ?? null,
            })
          }
          for (const job of jobs) {
            events.push({
              id: `job:${job.id}`,
              kind: 'job',
              at: job.startedAt ?? branch.createdAt,
              branchId: branch.id,
              turn: null,
              jobId: job.id,
              // 执行层（Operator）的状态：画方形节点、按状态染色
              state: job.state,
              label: job.label ?? job.id,
            })
          }
          const mergeNote = branch.mergedInto === null ? null : noteById.get(branch.mergedInto)
          return {
            id: branch.id,
            label: branch.label,
            summary: branch.summary,
            status: branch.status,
            forkAt: branch.createdAt,
            mergeAt: branch.status === 'merged' || branch.status === 'abandoned' ? branch.settledAt ?? branch.updatedAt : null,
            forkTurn: branch.forkedAtTurn ?? null,
            mergeTurn: branch.mergedAtTurn ?? null,
            mergedInto: branch.mergedInto ?? null,
            mergeClaim: mergeNote?.claim ?? null,
            premise: branch.context?.premise ?? '',
            quotes: branch.context?.quotes ?? [],
            facts: branch.context?.facts ?? [],
            jobs: jobs.map((job) => ({
              id: job.id,
              label: job.label,
              state: job.state,
              startedAt: job.startedAt ?? null,
              endedAt: job.endedAt ?? null,
            })),
          }
        })
        events.sort((a, b) => a.at - b.at)
        // 左侧脊：真实对话轮次（用户/助手都算），给时间轴一个可读的锚。
        const turnMap = new Map()
        for (const entry of this.state.observations) {
          const turn = entry.turn
          if (typeof turn !== 'number') continue
          if (entry.kind !== 'user' && entry.kind !== 'assistant') continue
          const line = String(entry.text ?? '')
            .split('\n')
            .map((part) => part.trim())
            .find((part) => part !== '')
          if (line === undefined) continue
          const existing = turnMap.get(turn)
          if (existing === undefined) {
            turnMap.set(turn, { turn, at: entry.at ?? 0, label: line.slice(0, 30), fromUser: entry.kind === 'user' })
          } else if (!existing.fromUser && entry.kind === 'user') {
            existing.label = line.slice(0, 30)
            existing.fromUser = true
          }
        }
        const turns = [...turnMap.values()]
          .sort((a, b) => a.turn - b.turn)
          .slice(-16)
          .map(({ turn, at, label }) => ({ turn, at, label }))
        return {
          turns,
          events,
          branches: nodes,
          counts: {
            activeLoops: this.listLoops().filter((loop) => loop.status === 'active').length,
            facts: this.listFacts().length,
            running: [...this.state.jobs.values()].filter((job) => job.state === 'running').length,
            drafts: this.listDrafts().length,
          },
        }
      })(),
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
        // 后台流水：让用户能手动看到「后台到底做了什么」，而不只是结论。
        notes: this.state.notes
          .slice(-40)
          .reverse()
          .map((note) => ({ id: note.id, kind: note.kind, claim: note.claim, at: note.at, why: note.why, branch: note.branch ?? null, loops: note.loops ?? [] })),
        briefings: this.state.briefings.slice(-6).reverse().map((record) => ({ kind: record.kind ?? 'briefing', day: record.day, at: record.at })),
        observations: {
          user: this.state.observations.filter((entry) => entry.kind === 'user').length,
          assistant: this.state.observations.filter((entry) => entry.kind === 'assistant').length,
          tool: this.state.observations.filter((entry) => entry.kind === 'tool').length,
        },
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
      if (day - draft.createdDay >= DEFAULTS.draftExpireDays) {
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
  /** 说过的每一句都带 id（U-<seq>），这样「我之前说过什么」可以被指认，而不是只被回忆。 */
  utteranceIndex() {
    return this.state.observations
      .filter((entry) => entry.kind === 'assistant' && String(entry.text ?? '').trim() !== '')
      .map((entry) => {
        const firstLine = String(entry.text ?? '')
          .split('\n')
          .map((line) => line.trim())
          .find((line) => line !== '')
        return {
          id: `U-${entry.seq}`,
          seq: entry.seq,
          turn: entry.turn ?? null,
          day: entry.day ?? null,
          text: (firstLine ?? '').slice(0, 200),
        }
      })
      .filter((entry) => entry.text !== '')
  }

  recentUtterances(limit = 8) {
    return this.utteranceIndex()
      .slice(-limit)
      .map((entry) => `${entry.id}｜${entry.text}`)
  }

  /**
   * 纠错的持久链接（SPEC §4.2）：不光看最近几句，还按词面相关性把**很久以前**
   * 说过的、可能和这次结果相关的话捞出来。确定性检索，不调模型。
   */
  relevantUtterances(query, { recent = 4, similar = 4 } = {}) {
    const index = this.utteranceIndex()
    if (index.length === 0) return []
    const recentPart = index.slice(-recent)
    const recentIds = new Set(recentPart.map((entry) => entry.id))
    const scored = index
      .filter((entry) => !recentIds.has(entry.id))
      .map((entry) => ({ entry, score: similarity(query, entry.text) }))
      .filter((item) => item.score >= 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, similar)
    return [...recentPart, ...scored.map((item) => item.entry)]
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
  async openBranch({ label, summary = '', forkedAtTurn = null, premise = '', quotes = [], facts = [] }) {
    const text = String(label ?? '').trim()
    if (text === '') throw new Error('分支要有个名字')
    const branch = makeBranch({
      id: `B-${this.state.counters.branch + 1}`,
      label: text,
      summary,
      premise,
      forkedAtTurn: forkedAtTurn ?? this.turn,
      forkedAtSeq: this.state.counters.obs,
      at: this.now(),
    })
    await this.enqueue(() => appendRecord(this.store, 'branches', { op: 'create', branch }))
    // 开分支时随句话带的前提与引用，当场落库（此前只有 context 动作才写，容易漏）。
    const cleanQuotes = (Array.isArray(quotes) ? quotes : []).map((quote) => String(quote).trim()).filter((quote) => quote !== '')
    const cleanFacts = Array.isArray(facts) ? facts.filter((id) => this.state.facts.has(String(id))) : []
    if (premise !== '' || cleanQuotes.length > 0 || cleanFacts.length > 0) {
      await this.updateBranchContext(branch.id, { premise, quotes: cleanQuotes, facts: cleanFacts })
    }
    return this.state.branches.get(branch.id)
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

  /**
   * 给分支补上下文切片（SPEC §2.4b）：前提 / 主干原文引用 / 依赖的事实卡。
   * 引用与事实只增不删；前提可改写，历史留在日志里。
   */
  async updateBranchContext(id, { premise, quotes = [], facts = [] } = {}) {
    const branch = this.state.branches.get(id)
    if (branch === undefined) throw new Error(`没有这条分支: ${id}`)
    const unknown = facts.filter((factId) => !this.state.facts.has(factId))
    if (unknown.length > 0) throw new Error(`引用了不存在的事实卡：${unknown.join('、')}`)
    await this.enqueue(() =>
      appendRecord(this.store, 'branches', {
        op: 'context',
        branchId: id,
        premise: typeof premise === 'string' ? premise.trim() : undefined,
        quotes: quotes.map((quote) => String(quote).trim()).filter((quote) => quote !== ''),
        facts,
        at: this.now(),
      }),
    )
    return this.state.branches.get(id)
  }

  /** 读一条分支的切片（Mind 需要「进分支里看」时用）。 */
  branchSlice(id) {
    const branch = this.state.branches.get(id)
    if (branch === undefined) throw new Error(`没有这条分支: ${id}`)
    const notes = this.state.notes.filter(
      (note) => note.branch === id || (Array.isArray(note.loops) && false),
    )
    return lossless({
      branch,
      text: renderBranchSlice(branch, this.state.facts),
      notes: notes.slice(-5),
      jobs: [...this.state.jobs.values()].filter((job) => job.branchId === id),
    })
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
      appendRecord(this.store, 'branches', { op: 'merge', branchId: id, mergedInto: note.id, turn: this.turn, at: this.now() }),
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

  // ── 叙事折叠：影子 → 验收 → 原子替换（SPEC §5.1） ──────────────────

  /** 第一步：Ink 做影子折叠，先不替换任何东西。 */
  async proposeFold({ archive = null, day = null } = {}) {
    const built = buildArchive(this.state.observations)
    const at = this.now()
    const proposal = makeProposal({
      id: `A-${this.state.counters.fold + 1}`,
      day: day ?? dayOf(at),
      epoch: this.state.epoch,
      archive: archive ?? built.archive,
      covered: built.covered,
      total: built.total,
      settlements: settlementDraft(this.listLoops()),
      at,
    })
    await this.enqueue(() => appendRecord(this.store, 'folds', { op: 'propose', proposal }))
    return proposal
  }

  listFolds({ includeSettled = true } = {}) {
    const all = [...this.state.folds.values()].sort((a, b) => b.createdAt - a.createdAt)
    return includeSettled ? all : all.filter((fold) => fold.status === 'pending')
  }

  pendingFold() {
    return this.listFolds({ includeSettled: false })[0] ?? null
  }

  /** 验收前先自查一遍（Mind 也可直接看理由）。 */
  reviewFold(id) {
    const proposal = this.state.folds.get(id)
    if (proposal === undefined) throw new Error(`没有这份折叠提案: ${id}`)
    return {
      proposal,
      problems: verifyProposal(proposal, { loops: this.listLoops() }),
      settlements: proposal.settlements,
      note: '判据只有一条：折叠之后，每条仍然活跃的开环都还得接得上。',
    }
  }

  /**
   * 第二步：Mind 验收。
   *  - 通过：可带自己改写的 archive（验收者用自己的话重写，比接受机器摘要更可靠）；
   *    有 compaction 服务就原子替换，没有就只记账（绝不偷偷改上下文）。
   *  - 退回：留下理由，重折一次。
   */
  async settleFold(id, { approve, archive = null, reason = null, agent = null, replace = null }) {
    const proposal = this.state.folds.get(id)
    if (proposal === undefined) throw new Error(`没有这份折叠提案: ${id}`)
    if (proposal.status !== 'pending') throw new Error(`这份提案已经处理过：${proposal.status}`)
    const at = this.now()

    if (!approve) {
      await this.enqueue(() =>
        appendRecord(this.store, 'folds', { op: 'reject', foldId: id, at, by: 'mind', reason }),
      )
      return { proposal: this.state.folds.get(id), settled: 'rejected', contextReplaced: false, reason: 'rejected-by-mind' }
    }

    // 验收对象是「实际要用的那份档案」：Mind 改写过就验改写后的。
    const effective =
      typeof archive === 'string' && archive.trim() !== ''
        ? { ...proposal, archive: archive.trim() }
        : proposal
    const problems = verifyProposal(effective, { loops: this.listLoops() })
    if (problems.length > 0) {
      throw new Error(`还没接得上，不能替换：${problems.join('；')}`)
    }

    let appliedSeq = null
    let replacement = 'not-attempted'
    if (typeof replace !== 'function') {
      replacement = 'no-replacer'
    } else {
      // 替换动作由调用方注入（生产实现是 DSH 的 /compact；测试里可以给假实现）。
      try {
        const outcome = await replace(agent)
        if (outcome?.applied === true) {
          appliedSeq = outcome.seq ?? this.state.counters.obs
          replacement = 'applied'
        } else {
          replacement = outcome?.reason ?? 'replacement-refused'
        }
      } catch (error) {
        replacement = `threw:${String(error?.message ?? error).slice(0, 80)}`
      }
    }

    await this.enqueue(() =>
      appendRecord(this.store, 'folds', {
        op: 'apply',
        foldId: id,
        at,
        by: 'mind',
        archive: effective.archive !== proposal.archive ? effective.archive : null,
        appliedSeq,
      }),
    )
    return {
      proposal: this.state.folds.get(id),
      settled: 'applied',
      // 提案已验收 = 已记账；contextReplaced 表示上下文是否真的被替换（受 DSH 隔离限制时会是 false）。
      contextReplaced: appliedSeq !== null,
      reason: replacement,
    }
  }

  // ── 念旧内容：详情仓（SPEC §2.2） ──────────────────────────────────

  /** 把一份长内容存进详情仓，返回 hash 与索引记录。 */
  async storeDetail(input) {
    const entry = await putDetail(this.stateDir, {
      ...input,
      at: input?.at ?? this.now(),
      turn: input?.turn ?? this.turn,
    })
    await this.enqueue(() => appendRecord(this.store, 'details', entry))
    return entry
  }

  readDetailText(hash) {
    return readDetail(this.stateDir, hash)
  }

  /** 按时间/开环/分支/实体/关键词检索。hash 只取回，检索靠索引。 */
  /**
   * 念旧：一个入口查所有历史（详情仓、决定账、观测原文、分支、事实）。
   * 之前只查详情仓——而详情仓只有长文本才会写，于是「查什么都不出来」。
   */
  recall({ query = null, entity = null, loop = null, branch = null, sinceDay = null, limit = 20 } = {}) {
    const needle = query === null ? null : String(query).toLowerCase()
    const match = (text) => (needle === null ? true : String(text ?? '').toLowerCase().includes(needle))
    const dayOk = (at) => (sinceDay === null ? true : dayOf(at) >= sinceDay)
    const hits = []

    for (const entry of searchIndex(this.state.details, { query, entity, loop, branch, sinceDay, limit: 50 })) {
      hits.push({ kind: 'detail', id: entry.hash, hash: entry.hash, at: entry.createdAt, day: entry.day, text: entry.preview })
    }
    for (const note of this.state.notes) {
      if (!dayOk(note.at)) continue
      if (loop !== null && !(note.loops ?? []).includes(loop)) continue
      if (branch !== null && note.branch !== branch) continue
      if (!match(`${note.claim} ${note.why} ${note.detail ?? ''}`)) continue
      hits.push({ kind: 'note', id: note.id, at: note.at, day: dayOf(note.at), text: note.claim })
    }
    for (const entry of this.state.observations) {
      if (entry.kind !== 'user' && entry.kind !== 'assistant') continue
      if (!dayOk(entry.at ?? 0)) continue
      if (!match(entry.text)) continue
      hits.push({ kind: 'utterance', id: `U-${entry.seq}`, at: entry.at ?? 0, day: entry.day ?? 0, text: String(entry.text ?? '').slice(0, 160) })
    }
    for (const entry of this.state.branches.values()) {
      if (branch !== null && entry.id !== branch) continue
      if (!dayOk(entry.createdAt)) continue
      const blob = `${entry.label} ${entry.summary} ${entry.context?.premise ?? ''} ${(entry.context?.quotes ?? []).join(' ')}`
      if (!match(blob)) continue
      hits.push({ kind: 'branch', id: entry.id, at: entry.createdAt, day: dayOf(entry.createdAt), text: `${entry.label}｜${entry.summary}` })
    }
    for (const fact of this.state.facts.values()) {
      if (!match(fact.claim)) continue
      const at = fact.revisedAt ?? fact.createdAt ?? 0
      if (!dayOk(at)) continue
      if (entity !== null && !String(fact.claim).includes(entity)) continue
      hits.push({ kind: 'fact', id: fact.id, at, day: dayOf(at), text: fact.claim })
    }

    return hits.sort((a, b) => b.at - a.at).slice(0, limit)
  }

  /** 回收：只删没被任何 note 引用、且超过保留期的详情。 */
  async gcDetails({ retentionDays = 30 } = {}) {
    const referenced = new Set()
    for (const note of this.state.notes) {
      if (typeof note.detailRef === 'string' && note.detailRef !== '') referenced.add(note.detailRef)
    }
    for (const entry of this.state.details) {
      if (entry.refs.some((ref) => this.state.notes.some((note) => note.id === ref))) referenced.add(entry.hash)
    }
    return gcDetails(this.stateDir, {
      entries: this.state.details,
      referencedHashes: referenced,
      now: this.now(),
      retentionDays,
    })
  }

  /** 回合结束后真正完成替换时补记（提案状态不变，只补 appliedSeq）。 */
  async markFoldReplaced(id, appliedSeq, reason = null) {
    await this.enqueue(() =>
      appendRecord(this.store, 'folds', { op: 'apply-late', foldId: id, appliedSeq, reason, at: this.now() }),
    )
    // 失败要看得到：投一条 note，它会出现在「流水」里。
    if (appliedSeq === null && reason !== null) {
      try {
        await this.deliverNote({
          kind: 'fold',
          claim: `折叠替换没成功：${String(reason).slice(0, 60)}`,
          why: 'fold:replace-failed',
          refs: [id],
          conf: 'low',
          detail: String(reason).slice(0, 800),
        })
      } catch {
        /* 记账失败时不再抛二次错误 */
      }
    }
    return this.state.folds.get(id)
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
    const today2 = dayOf(this.now())
    const wroteToday = this.state.briefings.some(
      (record) => record.day === today2 && (record.kind === undefined || record.kind === null),
    )
    const closing = [...this.state.briefings]
      .reverse()
      .find((record) => record.kind === 'closing-signal' && record.day === today2)
    if (closing !== undefined && !wroteToday) {
      lines.push('## 这次对话像是在收工')
      lines.push(`用户最后一句：「${closing.quote}」`)
      lines.push('如果今天到这儿，用 ink_brief save 写一段交接（推进/开环/在跑/草稿/下步），明天的你才接得上；不写也不算错。')
      lines.push('')
    }

    const pendingFold = this.pendingFold()
    if (pendingFold !== null) {
      lines.push('## 有一条折叠提案等你验收')
      lines.push(
        `档案 ${pendingFold.archive.trim().length} 字（覆盖 ${pendingFold.covered}/${pendingFold.total} 条），牵动开环 ${pendingFold.settlements.length} 条。`,
      )
      lines.push('验收判据只有一条：折叠之后，每条仍然活跃的开环都还得接得上。用 ink_fold review / approve / reject。')
      lines.push('')
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
