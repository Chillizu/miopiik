/**
 * miopiik-dsh — Client 半边（Web）。
 *
 * SPEC §6：不做导航栏，次级视图从对话里长出来。
 *  - conversation.view —— 唯一的 MiOpIIk 功能页（页签：鱼骨 / 未结事项 / 已定结论 / 运行中 / 草稿 / 交接记录 / 审计）
 *  - 抽屉（固定覆盖层，从存在感点开）—— 悬着的事 / 我们一起定的 / 后台在跑
 *
 * 数据：Host 的 session projection `miopiikBackstage`（已计算好，客户端不折事件）。
 * 干预：按钮走 session command `/miopiik ...`（同一 Host 操作，两处调用方；不经模型）。
 */
window.__ModuleLoader__.load({
  id: 'miopiik-dsh',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'miopiik'

    // Legacy Widget and IUI protocol bundles were retired from this client.
    // The independent miopiik-iui plugin owns trusted Markdown embedding.

    function createStore(initial) {
      let state = initial
      const listeners = new Set()
      return {
        get: () => state,
        set(next) {
          state = next
          for (const listener of listeners) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    const overlay = createStore({ open: false, tab: 'loops' })
    // 右栏入口：tab 类型的 id 与控制器引用（按钮要用它 openTab）。
    const INK_TAB_ID = 'miopiik-dsh/ink'
    let rightbar = null

    const useStore = React.useSyncExternalStore
      ? (store) => React.useSyncExternalStore(store.subscribe, store.get)
      : (store) => {
          const [, force] = React.useReducer((n) => n + 1, 0)
          React.useEffect(() => store.subscribe(force), [store])
          return store.get()
        }

    let t = (key) => key
    let clientCtx = null

    const C = {
      base: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      overlay: 'var(--dsw-alias-bg-overlay)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      // DSH 的品牌蓝是 static token；alias brand-primary 在本主题里是文字色。
      brand: 'var(--dsw-static-deepseek-500, #4176e6)',
      // 通信线用中性色：主色只留给两条脊，否则整张图都在喊。
      link: 'var(--dsw-alias-label-secondary)',
    }

    const styles = {
      row: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '8px 10px',
        border: `1px solid ${C.border}`,
        borderRadius: 8,
      },
      rowText: { flex: '1 1 auto', minWidth: 0, fontSize: 12, lineHeight: '18px', color: C.text },
      meta: { fontSize: 11, color: C.muted, lineHeight: '16px' },
      action: {
        flex: 'none',
        border: `1px solid ${C.border}`,
        background: 'transparent',
        color: C.muted,
        borderRadius: 6,
        padding: '2px 8px',
        fontSize: 11,
        cursor: 'pointer',
      },
      empty: {
        border: `1px dashed ${C.border}`,
        borderRadius: 10,
        padding: '18px 16px',
        color: C.muted,
        fontSize: 12,
        lineHeight: '18px',
      },
    }

    function runBackstageCommand(sessionId, line) {
      try {
        Promise.resolve(clientCtx.remote.commands.execute(sessionId, line, [])).catch((error) => {
          console.warn('[miopiik] 干预命令失败', error)
        })
      } catch (error) {
        console.warn('[miopiik] 干预通道不可用', error)
      }
    }

    // ── 全量流水取数通道（SPEC §2.2「账本即数据」）──────────────────────
    // 首屏是投影尾窗（零延迟、永远在场）；「更早」经 session command
    // `/miopiik audit`（与干预按钮同一条 remote.commands.execute 通道）翻
    // 磁盘上的原始 JSONL，游标 (before, beforeSeq) 保证从最新无缺口翻到最早。
    // 命令不可用就如实降级：停在尾窗，不硬绕。

    const AUDIT_PAGE_LIMIT = 50

    /** 组一条 /miopiik audit 命令行；键与 host/commands.js 的 parseAuditCommand 一一对应。 */
    function auditLine({ day = null, before = null, beforeSeq = null, kind = null, branch = null, limit = AUDIT_PAGE_LIMIT } = {}) {
      const parts = ['audit']
      if (day !== null) parts.push(`day=${day}`)
      if (before !== null) parts.push(`before=${before}`)
      if (beforeSeq !== null) parts.push(`beforeSeq=${beforeSeq}`)
      parts.push(`limit=${limit}`)
      if (kind !== null) parts.push(`kind=${kind}`)
      if (branch !== null) parts.push(`branch=${branch}`)
      return `/miopiik ${parts.join(' ')}`
    }

    /** nextCursor 两种形状都接：{before, beforeSeq, day}（游标续翻）或 {day}（按天跳翻）；空 = 翻完。 */
    function cursorParams(cursor) {
      if (cursor === null || typeof cursor !== 'object') return null
      if (cursor.before !== undefined) return { day: null, before: cursor.before, beforeSeq: cursor.beforeSeq ?? null }
      if (cursor.day !== undefined) return { day: cursor.day, before: null, beforeSeq: null }
      return null
    }

    /** 命令通道取一页：成功给 {page}，失败给 {error}；失败不静默兜底，让界面如实降级。 */
    async function fetchAuditPage(sessionId, line) {
      const commands = clientCtx?.remote?.commands
      if (commands === null || commands === undefined || typeof commands.execute !== 'function') {
        return { error: t('stream.noChannel') }
      }
      try {
        const outcome = await commands.execute(sessionId, line, [])
        if (outcome === null || outcome === undefined || outcome.ok !== true) {
          const detail = outcome?.error
          return { error: `${t('stream.noChannel')}${detail?.message ? `：${String(detail.message).slice(0, 80)}` : ''}` }
        }
        const execution = outcome.value
        if (execution === null || execution === undefined) return { error: t('stream.noChannel') }
        const result = execution.result
        if (result?.kind !== 'success') return { error: String(result?.text ?? t('stream.noChannel')).slice(0, 80) }
        const page = JSON.parse(result.text ?? 'null')
        if (page === null || typeof page !== 'object' || !Array.isArray(page.rows)) return { error: t('stream.badPage') }
        return { page }
      } catch (error) {
        return { error: String(error?.message ?? error).slice(0, 80) }
      }
    }

    /** 翻页拼接（纯函数，游标往返的可测面）：reset 换视图，append 只往尾部加、不动已看到的行。 */
    function mergeAuditPage(loaded, page) {
      const cursor = page?.nextCursor === null || page?.nextCursor === undefined ? null : page.nextCursor
      const incoming = Array.isArray(page?.rows) ? page.rows : []
      return { rows: loaded === null ? [...incoming] : [...loaded.rows, ...incoming], cursor, exhausted: cursor === null }
    }

    /** 投影尾窗 → 展示行：混合采样（最近 note/job + 当前事实/分支状态），不是事件流；kind 带 .sample 标记。 */
    function tailRows(audit) {
      if (audit === undefined || audit === null) return []
      const rows = []
      for (const note of audit.notes ?? []) {
        rows.push({ ...note, kind: String(note.kind ?? 'note'), rowKind: 'note', actor: 'ink', at: note.at ?? 0, refs: note.refs ?? [], branch: note.branch ?? null })
      }
      for (const fact of audit.factEvents ?? []) {
        rows.push({ id: fact.id, kind: 'fact.sample', rowKind: 'fact', actor: 'ink', at: fact.at ?? 0, claim: `${fact.stale ? '（已失效）' : ''}${fact.claim}`, refs: [fact.id], branch: null })
      }
      for (const branch of audit.branchEvents ?? []) {
        rows.push({ id: `ev-${branch.id}`, kind: 'branch.sample', rowKind: 'branch', actor: 'mind', at: branch.at ?? 0, claim: `${branch.id} ${branch.label} · ${branch.status}`, refs: [branch.id], branch: branch.id })
      }
      for (const job of audit.jobs ?? []) {
        rows.push({ id: job.id, kind: 'job.sample', rowKind: 'job', actor: 'operator', at: job.startedAt ?? job.endedAt ?? 0, claim: `${job.id} ${job.state} — ${job.label}`, refs: [job.id], branch: job.branchId ?? null, job })
      }
      return rows.sort((a, b) => b.at - a.at)
    }

    /** 溯源匹配：行的账本 id 命中，或它的 refs 里提到这个 id（牵动过它的都算）。 */
    function rowTracesTo(row, id) {
      return row.id === id || (Array.isArray(row.refs) && row.refs.includes(id))
    }

    // ── 行面 actor 小签（§13.10）：不用点开行详情就能认出是哪层的手笔 ──────
    // 三色走 C.* 主题变量：mind=品牌蓝（与脊同源）、ink=中性灰（回合边界的静默结算）、
    // operator=琥珀（与任务方点的运行色同源）；其余署名（如 user 干预）用正文色。
    function actorColorOf(actor) {
      if (actor === 'mind') return C.brand
      if (actor === 'ink') return C.muted
      if (actor === 'operator') return C.warn
      return C.text
    }

    /** 小签本体：文本走 i18n 键（actor.mind/ink/operator），悬停说明走各自 hint 键。 */
    function ActorChip({ actor }) {
      if (typeof actor !== 'string' || actor === '') return null
      const color = actorColorOf(actor)
      const label = ['mind', 'ink', 'operator', 'user'].includes(actor) ? t(`actor.${actor}`) : actor
      const hint = ['mind', 'ink', 'operator'].includes(actor) ? t(`actor.${actor}Hint`) : undefined
      return h(
        'span',
        {
          'data-miopiik-actor': actor,
          title: hint,
          style: {
            flex: 'none',
            fontSize: 10,
            lineHeight: '14px',
            padding: '0 5px',
            border: `0.5px solid ${color}`,
            borderRadius: 7,
            color,
            whiteSpace: 'nowrap',
          },
        },
        label,
      )
    }

    // ── 对话里的 MiOpIIk 手笔（SPEC §13.11）────────────────────────────────
    // DSH 的通用工具行会把参数原样露出来（`ink_loops · {"action":"close","id":"L-33"}`），
    // 命令行更糟：`/miopiik audit` 的返回是整页 JSON，会整段灌进对话。
    // 这两个席位（tool.call.toolview / conversation.chat.commandview）都是我们自己的手笔，
    // 只有我们知道那些字段是什么意思，所以由我们接管：折叠态给人话（名词 · 动词 对象），
    // 展开态给结构化正文。只做展示层：不改 host 契约、不动工具返回给模型的文本、不发明数据。

    const INK_TOOL_NAMES = [
      'ink_status',
      'ink_loops',
      'ink_facts',
      'ink_inbox',
      'ink_dispatch',
      'ink_commit',
      'ink_brief',
      'ink_epoch',
      'ink_draft',
      'ink_ask',
      'ink_report',
      'ink_branch',
      'ink_fold',
      'ink_recall',
    ]

    /** 参数读取器：流式 PartialArguments 与普通对象（测试/回放）用同一套接口。 */
    function inkArgsReader(args) {
      const source = args ?? null
      if (source !== null && typeof source.text === 'function' && typeof source.value === 'function') {
        return { text: (key) => source.text(key), value: (key) => source.value(key) }
      }
      const object = source !== null && typeof source === 'object' ? source : {}
      return {
        text: (key) => (typeof object[key] === 'string' ? object[key] : undefined),
        value: (key) => object[key],
      }
    }

    /** 结果节点 → 已解析的值：工具输出是 render() 出来的 pretty JSON 文本块。 */
    function inkResultValue(block) {
      const content = Array.isArray(block?.content) ? block.content : []
      const textBlock = content.find((entry) => entry !== null && typeof entry === 'object' && entry.type === 'text')
      if (textBlock === undefined) return null
      const text = String(textBlock.text ?? '')
      if (text === '') return null
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    }

    function inkClip(value, max) {
      const text = String(value ?? '')
        .replace(/\s+/gu, ' ')
        .trim()
      return text.length > max ? `${text.slice(0, max)}…` : text
    }

    // 工具名 → 名词（同一套 i18n 键：zh/en 各一份）。
    const INK_NOUNS = {
      ink_status: 'ink.noun.status',
      ink_loops: 'ink.noun.loops',
      ink_facts: 'ink.noun.facts',
      ink_inbox: 'ink.noun.inbox',
      ink_dispatch: 'ink.noun.dispatch',
      ink_commit: 'ink.noun.commit',
      ink_brief: 'ink.noun.brief',
      ink_epoch: 'ink.noun.epoch',
      ink_draft: 'ink.noun.draft',
      ink_ask: 'ink.noun.ask',
      ink_report: 'ink.noun.report',
      ink_branch: 'ink.noun.branch',
      ink_fold: 'ink.noun.fold',
      ink_recall: 'ink.noun.recall',
    }

    const INK_ACTIONS = {
      list: 'ink.act.list',
      get: 'ink.act.get',
      add: 'ink.act.add',
      touch: 'ink.act.touch',
      close: 'ink.act.close',
      drop: 'ink.act.drop',
      open: 'ink.act.open',
      read: 'ink.act.read',
      star: 'ink.act.star',
      unstar: 'ink.act.unstar',
      defer: 'ink.act.defer',
      revise: 'ink.act.revise',
      invalidate: 'ink.act.invalidate',
      merge: 'ink.act.merge',
      abandon: 'ink.act.abandon',
      summary: 'ink.act.summary',
      context: 'ink.act.context',
      propose: 'ink.act.propose',
      review: 'ink.act.review',
      approve: 'ink.act.approve',
      reject: 'ink.act.reject',
      materials: 'ink.act.materials',
      save: 'ink.act.save',
      latest: 'ink.act.latest',
      advance: 'ink.act.advance',
    }

    function inkActionWord(action) {
      const value = typeof action === 'string' ? action : ''
      const key = INK_ACTIONS[value]
      return key === undefined ? value : t(key)
    }

    /** 折叠行的人话：名词 + 一句细节，全部从参数读——流式阶段照样成立。 */
    function inkToolLabel(toolName, read) {
      const pick = (key) => {
        const text = read.text(key)
        return typeof text === 'string' && text !== '' ? text : undefined
      }
      const nounKey = INK_NOUNS[toolName]
      const noun = nounKey === undefined ? toolName : t(nounKey)
      const action = pick('action')
      const id = pick('id')
      const verb = inkActionWord(action)
      const isList = action === undefined || action === 'list'
      let detail = ''
      switch (toolName) {
        case 'ink_status':
          break
        case 'ink_loops':
          if (action === 'add') detail = `${verb} ${inkClip(pick('text'), 18)}`
          else if (isList) detail = t('ink.act.list')
          else detail = `${verb} ${id ?? ''}`.trim()
          break
        case 'ink_facts':
          if (action === 'add') detail = `${verb} ${inkClip(pick('claim'), 18)}`
          else if (isList) detail = t('ink.act.list')
          else detail = `${verb} ${id ?? ''}`.trim()
          break
        case 'ink_inbox':
          detail = isList ? t('ink.act.list') : `${verb} ${id ?? ''}`.trim()
          break
        case 'ink_dispatch':
          detail = inkClip(pick('goal'), 26)
          break
        case 'ink_commit':
          detail = inkClip(pick('title'), 20)
          break
        case 'ink_brief':
          detail = isList ? t('ink.act.materials') : verb
          break
        case 'ink_epoch':
          detail = inkClip(pick('note'), 22)
          break
        case 'ink_draft':
          if (action === 'add') detail = `${verb} ${inkClip(pick('title'), 18)}`
          else if (action === 'drop') detail = `${verb} ${id ?? ''}`.trim()
          else detail = t('ink.act.list')
          break
        case 'ink_ask':
          detail = inkClip(pick('question'), 24)
          break
        case 'ink_report':
          detail = inkClip(pick('claim'), 24)
          break
        case 'ink_branch': {
          const label = pick('label')
          if (action === 'open') detail = `${verb} ${inkClip(label, 16)}`
          else if (isList) detail = t('ink.act.list')
          else if (action === 'merge') detail = `${verb} ${id ?? ''} ${inkClip(pick('claim'), 14)}`.trim()
          else detail = `${verb} ${id ?? ''}`.trim()
          break
        }
        case 'ink_fold':
          detail = isList ? t('ink.act.list') : `${verb} ${id ?? ''}`.trim()
          break
        case 'ink_recall': {
          const parts = []
          for (const key of ['query', 'entity', 'loop', 'branch']) {
            const value = pick(key)
            if (value !== undefined) parts.push(key === 'query' ? `“${inkClip(value, 16)}”` : value)
          }
          const readBack = pick('read')
          if (readBack !== undefined) parts.push(`#${inkClip(readBack, 8)}`)
          detail = parts.join(' · ')
          break
        }
        default:
          break
      }
      return { noun, detail }
    }

    /** 状态词本地化：账本里存的是英文状态，对话里说人话。 */
    function inkStatusWord(status) {
      if (status === 'merged') return t('graph.merged')
      if (status === 'abandoned') return t('graph.abandoned')
      if (status === 'open') return t('graph.open')
      return typeof status === 'string' ? status : ''
    }

    /** 结果落地后再补一句只有结果才知道的话（状态、判定、条数）；失败与进行中优先。 */
    function inkToolOutcome(toolName, value, block, phase, read) {
      if (block?.isError === true) return t('ink.row.failed')
      if (phase === 'preparing') return t('ink.row.preparing')
      if (phase === 'start') return t('ink.row.running')
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return ''
      const verb = inkActionWord(read?.text?.('action'))
      const countOf = (list) => (Array.isArray(list) ? `${list.length} ${t('ink.row.count')}` : '')
      if (toolName === 'ink_status') {
        const loops = value.loops ?? {}
        const facts = value.facts ?? {}
        const inbox = value.inbox ?? {}
        return `${t('ink.noun.loops')} ${loops.active ?? 0} · ${t('ink.noun.facts')} ${facts.active ?? 0} · ${t('ink.noun.inbox')} ${inbox.pending ?? 0}`
      }
      if (toolName === 'ink_loops') {
        if (Array.isArray(value.loops)) return countOf(value.loops)
        if (typeof value.loop?.id === 'string') return `${verb} ${value.loop.id}`.trim()
      }
      if (toolName === 'ink_facts') {
        if (Array.isArray(value.facts)) return countOf(value.facts)
        if (typeof value.fact?.id === 'string') return `${verb} ${value.fact.id}`.trim()
      }
      if (toolName === 'ink_inbox') {
        if (Array.isArray(value.previews)) return countOf(value.previews)
        if (Array.isArray(value.items)) return `${value.zone ? t(`ink.zone.${value.zone}`) : ''} ${countOf(value.items)}`.trim()
        const itemId = typeof value.id === 'string' ? value.id : value.item?.id
        if (typeof itemId === 'string') return `${verb} ${itemId}`.trim()
      }
      if (toolName === 'ink_dispatch' && typeof value.jobId === 'string') return `${t('ink.row.dispatched')} ${value.jobId}`
      if (toolName === 'ink_commit') return value.approved === true ? t('ink.row.approved') : t('ink.row.rejected')
      if (toolName === 'ink_branch') {
        if (Array.isArray(value.branches)) return countOf(value.branches)
        if (typeof value.branch?.id === 'string') return `${verb} ${value.branch.id} · ${inkStatusWord(value.branch.status)}`.trim()
      }
      if (toolName === 'ink_fold') {
        if (Array.isArray(value.proposals)) return countOf(value.proposals)
        const fold = value.proposal ?? null
        if (typeof fold?.id === 'string') return `${verb} ${fold.id} · ${inkStatusWord(fold.status)}`.trim()
        if (typeof value.settled === 'string') return `${verb} · ${inkStatusWord(value.settled)}`.trim()
      }
      if (toolName === 'ink_draft') {
        if (Array.isArray(value.drafts)) return countOf(value.drafts)
        if (typeof value.draft?.id === 'string') return `${verb} ${value.draft.id}`.trim()
      }
      if (toolName === 'ink_recall') {
        if (typeof value.count === 'number') return `${value.count} ${t('ink.row.count')}`
        if (typeof value.hash === 'string') return `#${value.hash.slice(0, 8)}`
      }
      if (toolName === 'ink_brief') {
        if (Array.isArray(value.activeLoops)) return `${value.activeLoops.length} ${t('ink.row.count')}`
        const at = value.briefing?.at
        if (typeof at === 'number') return new Date(at).toLocaleDateString('zh-CN')
      }
      if (toolName === 'ink_epoch' && typeof value.epoch === 'number') return `E${value.epoch}`
      if ((toolName === 'ink_report' || toolName === 'ink_ask') && typeof value.fact?.id === 'string') return value.fact.id
      return ''
    }

    // 展开正文里优先摊开的参数字段（契约、判定、问题这类「意思在参数里」的工具）。
    const INK_ARG_FIELDS = {
      ink_dispatch: ['goal', 'deliverables', 'acceptance', 'acceptanceSample', 'boundary', 'budget'],
      ink_commit: ['title', 'summary', 'draftId'],
      ink_ask: ['question'],
      ink_report: ['claim', 'evidence', 'conf'],
      ink_epoch: ['note'],
      ink_loops: ['text', 'type', 'pointer', 'closureCondition'],
      ink_facts: ['claim', 'provenance', 'conf', 'source', 'validUntil'],
      ink_branch: ['label', 'summary', 'premise', 'quotes', 'claim', 'detail'],
      ink_fold: ['archive'],
      ink_draft: ['title', 'summary', 'artifact'],
      ink_brief: ['progress', 'loops', 'running', 'drafts', 'next'],
      ink_recall: ['query', 'entity', 'loop', 'branch', 'sinceDay', 'read'],
    }

    const INK_FIELD_LABELS = {
      goal: 'ink.field.goal',
      deliverables: 'ink.field.deliverables',
      acceptance: 'ink.field.acceptance',
      acceptanceSample: 'ink.field.acceptanceSample',
      boundary: 'ink.field.boundary',
      budget: 'ink.field.budget',
      claim: 'ink.field.claim',
      evidence: 'ink.field.evidence',
      conf: 'ink.field.conf',
      title: 'ink.field.title',
      summary: 'ink.field.summary',
      draftId: 'ink.field.draftId',
      question: 'ink.field.question',
      note: 'ink.field.note',
      text: 'ink.field.text',
      type: 'ink.field.type',
      pointer: 'ink.field.pointer',
      closureCondition: 'ink.field.closureCondition',
      provenance: 'ink.field.provenance',
      source: 'ink.field.source',
      validUntil: 'ink.field.validUntil',
      label: 'ink.field.label',
      premise: 'ink.field.premise',
      quotes: 'ink.field.quotes',
      detail: 'ink.field.detail',
      archive: 'ink.field.archive',
      artifact: 'ink.field.artifact',
      progress: 'ink.field.progress',
      running: 'ink.field.running',
      drafts: 'ink.field.drafts',
      next: 'ink.field.next',
      query: 'ink.field.query',
      entity: 'ink.field.entity',
      sinceDay: 'ink.field.sinceDay',
      read: 'ink.field.read',
    }

    /** 字段名 → 人话；不认识的字段名原样给（英文键至少还能对上账本）。 */
    function inkFieldLabel(key) {
      const keyName = INK_FIELD_LABELS[key]
      return keyName === undefined ? key : t(keyName)
    }

    const INK_ITEM_TEXT = ['claim', 'text', 'label', 'goal', 'question', 'title', 'preview', 'summary', 'name', 'message', 'reason', 'note', 'detail']
    const INK_ITEM_CHIPS = ['status', 'state', 'kind', 'conf', 'source', 'tier']
    const INK_SKIP_FIELDS = new Set([...INK_ITEM_TEXT, ...INK_ITEM_CHIPS, 'id', 'scope', 'at', 'stale', 'branchId', 'branch', 'loopId'])

    function inkChip(label, color) {
      return h(
        'span',
        {
          key: `chip-${label}`,
          style: {
            flex: 'none',
            fontSize: 10,
            lineHeight: '14px',
            padding: '0 5px',
            border: `0.5px solid ${color}`,
            borderRadius: 7,
            color,
            whiteSpace: 'nowrap',
          },
        },
        label,
      )
    }

    function inkFieldRow(key, value) {
      const text = Array.isArray(value) ? value.join('、') : typeof value === 'object' ? JSON.stringify(value) : String(value)
      return h(
        'div',
        {
          key: `field-${key}`,
          style: { display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 },
        },
        h('span', { style: { flex: '0 0 auto', minWidth: 52, maxWidth: 96, fontSize: 11, lineHeight: '17px', color: C.muted } }, inkFieldLabel(key)),
        h('span', { style: { flex: '1 1 auto', minWidth: 0, fontSize: 12, lineHeight: '17px', color: C.text, wordBreak: 'break-word' } }, text),
      )
    }

    /** 数组条目一行：id + 主句 + 徽章 + 次要字符串（缩进第二行）。 */
    function inkItemRow(item, index) {
      if (item === null || item === undefined) return null
      if (typeof item !== 'object') {
        return h('div', { key: `item-${index}`, style: { fontSize: 12, lineHeight: '17px', color: C.text } }, String(item))
      }
      const id = typeof item.id === 'string' ? item.id : null
      const primary = (() => {
        for (const key of INK_ITEM_TEXT) {
          const value = item[key]
          if (typeof value === 'string' && value.trim() !== '') return value
        }
        return null
      })()
      const chips = []
      for (const key of INK_ITEM_CHIPS) {
        if (typeof item[key] === 'string' && item[key] !== '') chips.push(inkChip(item[key], actorColorOf(item[key]) === C.text ? C.muted : actorColorOf(item[key])))
      }
      if (item.stale === true) chips.push(inkChip(t('ink.row.stale'), C.muted))
      if (typeof item.at === 'number' && item.at > 0) {
        chips.push(inkChip(new Date(item.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), C.muted))
      }
      const rest = Object.entries(item).filter(
        ([key, value]) => typeof value === 'string' && !INK_SKIP_FIELDS.has(key) && value.trim() !== '',
      )
      return h(
        'div',
        { key: `item-${index}`, style: { display: 'flex', flexDirection: 'column', gap: 1, padding: '3px 0', borderTop: index === 0 ? 'none' : `0.5px solid ${C.border}` } },
        h(
          'div',
          { style: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' } },
          id === null ? null : inkChip(id, C.brand),
          primary === null ? null : h('span', { style: { flex: '1 1 160px', minWidth: 0, fontSize: 12, lineHeight: '17px', color: C.text } }, primary),
          ...chips,
        ),
        rest.length === 0
          ? null
          : h(
              'div',
              { style: { fontSize: 11, lineHeight: '16px', color: C.muted, paddingLeft: id === null ? 0 : 2 } },
              rest.map(([key, value]) => `${inkFieldLabel(key)} ${inkClip(value, 120)}`).join(' · '),
            ),
      )
    }

    /** 结构化正文：契约参数在前，结果在后；不给整段 JSON 回来。 */
    function inkBodyNodes(toolName, read, value) {
      const nodes = []
      // 后台总览是「一眼看完」的账，不摊原始字段（session 号这类不是给人看的）。
      if (toolName === 'ink_status' && value !== null && typeof value === 'object') {
        const loops = value.loops ?? {}
        const facts = value.facts ?? {}
        const inbox = value.inbox ?? {}
        const metric = (key, label, text) =>
          h(
            'div',
            { key: `metric-${key}`, style: { display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 12, lineHeight: '18px' } },
            h('span', { style: { flex: '0 0 62px', color: C.muted } }, label),
            h('span', { style: { flex: '1 1 auto', color: C.text, fontVariantNumeric: 'tabular-nums' } }, text),
          )
        return [
          metric(
            'loops',
            t('ink.noun.loops'),
            `${t('ink.status.active')} ${loops.active ?? 0} · ${t('ink.status.dormant')} ${loops.dormant ?? 0} · ${t('ink.status.closed')} ${loops.closed ?? 0}（${t('ink.status.cap')} ${loops.cap ?? 0}）`,
          ),
          metric('facts', t('ink.noun.facts'), `${facts.active ?? 0} · ${t('ink.status.stale')} ${facts.stale ?? 0}`),
          metric('inbox', t('ink.noun.inbox'), `${t('ink.status.pending')} ${inbox.pending ?? 0}`),
          metric('notes', t('ink.status.notes'), `${value.notes ?? 0} · ${t('ink.status.observations')} ${value.observations ?? 0}`),
          metric('pos', t('ink.status.position'), `T${value.turn ?? 0} · D${value.day ?? 0} · E${value.epoch ?? 0}`),
        ]
      }
      for (const key of INK_ARG_FIELDS[toolName] ?? []) {
        const text = read.text(key)
        const raw = text !== undefined ? text : read.value(key)
        if (raw === undefined || raw === null || raw === '') continue
        nodes.push(inkFieldRow(key, raw))
      }
      if (value !== null && typeof value === 'object') {
        // 结果常是 {loop:{…}} / {fact:{…}} 这种单键包装：拆掉包装再摊，别让包装名占一行。
        const WRAPPED = ['loop', 'fact', 'branch', 'proposal', 'draft', 'briefing', 'job', 'item']
        const unwrapped =
          !Array.isArray(value) &&
          Object.keys(value).length === 1 &&
          WRAPPED.includes(Object.keys(value)[0]) &&
          value[Object.keys(value)[0]] !== null &&
          typeof value[Object.keys(value)[0]] === 'object'
            ? value[Object.keys(value)[0]]
            : value
        const entries = Array.isArray(unwrapped) ? [['', unwrapped]] : Object.entries(unwrapped)
        for (const [key, entry] of entries) {
          if (entry === undefined || entry === null || entry === '') continue
          if (Array.isArray(entry)) {
            if (entry.length === 0) continue
            nodes.push(
              h(
                'div',
                { key: `list-${key}`, style: { display: 'flex', flexDirection: 'column' } },
                key === '' ? null : h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.muted, paddingTop: 2 } }, inkFieldLabel(key)),
                ...entry.map((item, index) => inkItemRow(item, index)),
              ),
            )
          } else if (typeof entry === 'object') {
            const inner = Object.entries(entry).filter(([, item]) => item !== null && typeof item !== 'object')
            if (inner.length === 0) continue
            nodes.push(
              h(
                'div',
                { key: `obj-${key}`, style: { display: 'flex', flexDirection: 'column', gap: 2, borderTop: `0.5px solid ${C.border}`, paddingTop: 4, marginTop: 2 } },
                h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.muted } }, inkFieldLabel(key)),
                ...inner.map(([innerKey, item]) => inkFieldRow(innerKey, item)),
              ),
            )
          } else if (key !== '') {
            nodes.push(inkFieldRow(key, entry))
          } else {
            nodes.push(inkFieldRow('text', entry))
          }
        }
      } else if (typeof value === 'string' && value !== '') {
        nodes.push(inkFieldRow('text', value))
      }
      return nodes
    }

    /** 工具行：折叠态一句人话，展开态结构化正文；配合过程组折叠，不抢对话的版面。 */
    function InkToolRow(props) {
      const toolName = typeof props?.toolName === 'string' ? props.toolName : ''
      const block = props?.block ?? {}
      const useDisclosure = props?.useDisclosure
      const disclosure = typeof useDisclosure === 'function' ? useDisclosure() : { expanded: false, toggle() {} }
      const phase = typeof props?.phase === 'string' ? props.phase : 'result'
      const read = inkArgsReader(block.args)
      const value = phase === 'result' ? inkResultValue(block) : null
      const label = inkToolLabel(toolName, read)
      const outcome = inkToolOutcome(toolName, value, block, phase, read)
      const detail = outcome === '' ? label.detail : outcome
      const failed = block.isError === true
      const running = phase === 'preparing' || phase === 'start'
      const errorText = (() => {
        if (!failed) return ''
        const content = Array.isArray(block.content) ? block.content : []
        const first = content.find((entry) => entry !== null && typeof entry === 'object' && entry.type === 'text')
        return inkClip(first?.text ?? t('ink.row.failed'), 160)
      })()
      const body = disclosure.expanded ? inkBodyNodes(toolName, read, failed ? null : value) : []
      return h(
        'div',
        {
          'data-miopiik-tool-row': toolName,
          'data-tool': toolName,
          'data-state': failed ? 'error' : running ? 'running' : 'ok',
          style: { display: 'flex', flexDirection: 'column', minWidth: 0, padding: '1px 0' },
        },
        h(
          'button',
          {
            type: 'button',
            onClick: disclosure.toggle,
            'aria-expanded': disclosure.expanded ? 'true' : 'false',
            style: {
              display: 'flex',
              alignItems: 'baseline',
              gap: 6,
              width: '100%',
              minWidth: 0,
              padding: '2px 0',
              border: 0,
              background: 'transparent',
              color: C.text,
              cursor: 'pointer',
              textAlign: 'left',
              font: 'inherit',
            },
          },
          h(
            'svg',
            { width: 13, height: 13, viewBox: '0 0 13 13', 'aria-hidden': true, style: { flex: 'none', alignSelf: 'center', opacity: running ? 0.5 : 0.9 } },
            h('path', { d: 'M6.5 1.2 L11.8 6.5 L6.5 11.8 L1.2 6.5 Z', fill: 'none', stroke: failed ? C.error : C.brand, strokeWidth: 1.3 }),
          ),
          h('span', { style: { flex: 'none', fontSize: 12, lineHeight: '18px', color: failed ? C.error : C.text } }, label.noun),
          detail === '' ? null : h('span', { style: { flex: 'none', fontSize: 12, lineHeight: '18px', color: C.muted } }, '·'),
          detail === '' ? null : h('span', { style: { minWidth: 0, fontSize: 12, lineHeight: '18px', color: failed ? C.error : C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, detail),
        ),
        failed && !disclosure.expanded ? h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.error, paddingLeft: 19 } }, errorText) : null,
        body.length === 0
          ? null
          : h(
              'div',
              {
                'data-miopiik-tool-body': toolName,
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                  margin: '2px 0 6px 19px',
                  padding: '7px 10px',
                  borderLeft: `2px solid ${failed ? C.error : C.brand}`,
                  background: C.layer1,
                  borderRadius: '0 6px 6px 0',
                },
              },
              ...body,
            ),
      )
    }

    /** 命令行：`/miopiik audit …` 每次翻页都会留一行。结果 JSON 不进对话，只报做了什么。 */
    function MiCommandRow(props) {
      const node = props?.node ?? {}
      const raw = typeof node.args === 'string' ? node.args.trim() : ''
      const tokens = raw === '' ? [] : raw.split(/\s+/u)
      const domain = tokens[0] ?? ''
      const verb = tokens[1] ?? ''
      const id = tokens[2] ?? ''
      const outcome = node.outcome ?? null
      const failed = outcome !== null && outcome.kind === 'error'
      const pending = outcome === null
      const resultText = typeof outcome?.text === 'string' ? outcome.text : ''
      // audit 的返回是整页 JSON：翻页的意义只有「翻了多少」，行数据在视图里，不灌进对话。
      const page = (() => {
        if (resultText === '') return null
        if (!resultText.startsWith('{')) return null
        try {
          const parsed = JSON.parse(resultText)
          return parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.rows) ? parsed : null
        } catch {
          return null
        }
      })()
      let label = ''
      let detail = ''
      if (page !== null) {
        label = t('ink.cmd.audit')
        detail = `${page.rows.length} ${t('ink.cmd.rows')}`
      } else if (domain === 'loop') {
        label = verb === 'drop' ? t('ink.cmd.loopDrop') : t('ink.cmd.loopClose')
        detail = id
      } else if (domain === 'fact') {
        label = t('ink.cmd.factInvalidate')
        detail = id
      } else if (resultText !== '' && resultText.startsWith('{') !== true) {
        // 干预命令的返回本来就是一句人话（「已划掉 L-33」），照抄即可。
        label = inkClip(resultText, 40)
      } else {
        label = 'miopiik'
        detail = inkClip(raw, 40)
      }
      return h(
        'div',
        {
          'data-miopiik-cmd-row': page !== null ? 'audit' : domain === '' ? 'miopiik' : domain,
          style: { display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0, padding: '2px 0', color: C.muted },
        },
        h('span', {
          'aria-hidden': true,
          style: {
            flex: 'none',
            alignSelf: 'center',
            width: 5,
            height: 5,
            borderRadius: 3,
            background: failed ? C.error : pending ? C.muted : C.brand,
            opacity: 0.75,
          },
        }),
        h('span', { style: { flex: 'none', fontSize: 11.5, lineHeight: '17px', color: failed ? C.error : C.text } }, label),
        detail === '' ? null : h('span', { style: { minWidth: 0, fontSize: 11, lineHeight: '17px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `· ${detail}`),
      )
    }

    // 与 DSH 自带的「对话 / 轨迹」标签同一套度量：13px、字重 500、激活用品牌色、下划线指示。
    function TabButton({ id, label, active }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': active ? 'true' : 'false',
          onClick: () => overlay.set({ ...overlay.get(), tab: id }),
          style: {
            padding: '0 3px 9px',
            border: 0,
            borderBottom: active ? `2px solid ${C.brand}` : '2px solid transparent',
            background: 'transparent',
            color: active ? C.brand : C.muted,
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 500,
            lineHeight: '16px',
            whiteSpace: 'nowrap',
          },
        },
        label,
      )
    }

    function CountsStrip({ graph }) {
      const counts = graph?.counts
      if (counts === undefined) return null
      const items = [
        [t('count.loops'), counts.activeLoops],
        [t('count.facts'), counts.facts],
        [t('count.running'), counts.running],
        [t('count.drafts'), counts.drafts],
      ]
      return h(
        'div',
        { style: { display: 'flex', gap: 18, padding: '2px 0 10px' } },
        ...items.map(([label, value]) =>
          h(
            'div',
            { key: label, style: { display: 'flex', flexDirection: 'column', gap: 1 } },
            h('span', { style: { fontSize: 16, fontWeight: 600, lineHeight: '20px', color: C.text } }, String(value)),
            h('span', { style: { fontSize: 11, color: C.muted } }, label),
          ),
        ),
      )
    }

    /**
     * 鱼骨（泳道化）：左脊是主干对话轮次（主色只给脊），右面按分支一条泳道；
     * fork 行从脊接出、merge/abandon 行接回脊，job 方点落在自己泳道上。
     * 脊与分支泳道之间单开一条 Mind 泳道：菱形节点 = Mind 署名动作（graph.mindEvents，
     * host 从账本实据推导，SPEC §13.10），悬停给 label+refs+时间，点击去流水溯源。
     * 跨泳道细线 = 两条分支共享同一张事实卡：悬停看事实号，点击去流水溯源。
     * 形状语言：圆 = Ink 侧事件，方 = Operator 任务，菱形 = Mind 动作，颜色 = 状态。
     */
    function FishboneView(props) {
      const { sessionId, useProjection, onOpenStream, onOpenFact, onOpenJob, onTraceMind, focusBranch } = props ?? {}
      const snapshot = typeof useProjection === 'function' ? useProjection('miopiikBackstage') : undefined
      const graph = snapshot?.graph
      const [hover, setHover] = React.useState(null)
      const [selected, setSelected] = React.useState(null)
      React.useEffect(() => {
        if (typeof focusBranch === 'string' && focusBranch !== '') setSelected(focusBranch)
      }, [focusBranch])
      const branches = graph?.branches ?? []
      const events = graph?.events ?? []
      const mindEvents = graph?.mindEvents ?? []
      // 画布宽度跟着可用列宽走：泳道摊开而不是挤在中间一条窄带里。
      const [avail, setAvail] = React.useState(0)
      const canvasRef = React.useRef(null)
      React.useEffect(() => {
        const el = canvasRef.current
        if (el === null || typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver((entries) => {
          const next = entries[0]?.contentRect?.width ?? 0
          if (next > 0) setAvail(next)
        })
        observer.observe(el)
        return () => observer.disconnect()
      }, [])

      if (graph === undefined || branches.length === 0) {
        return h('div', { style: { padding: 32, color: C.muted, fontSize: 13 } }, t('graph.empty'))
      }

      // 泳道布局：左脊（对话轮次）+ Mind 泳道 + 每分支一条泳道，时间一律向下。
      const turns = graph?.turns ?? []
      const windowLabel =
        graph.turnsTruncated === true
          ? `${t('graph.recentTurns')} ${turns.length}/${graph.turnsTotal}`
          : `${t('graph.allTurns')} ${graph.turnsTotal}`
      const stateColor = (state) => {
        if (state === 'running') return C.warn
        if (state === 'done') return C.success
        if (state === 'failed' || state === 'stalled' || state === 'timeout') return C.error
        return C.muted
      }
      const statusLabel = (branch) =>
        branch.status === 'merged'
          ? `${t('graph.merged')}${branch.mergedInto ? ` ${branch.mergedInto}` : ''}`
          : branch.status === 'abandoned'
            ? t('graph.abandoned')
            : t('graph.open')

      // 画布内只留泳道标题（y=18）；图例与轮次窗口搬到画布外的工具条里。
      // 首行事件从 padTop 起，任何标题字形不压事件节点的点击与悬停。
      const padTop = 44
      const rowGap = 34
      const leftX = 96
      const laneBase = leftX + 150
      // 泳道宽随列宽伸缩（150–270）：宽屏把两条道摊开，窄屏保持可读。
      const laneW =
        avail > 0 && branches.length > 0
          ? Math.max(150, Math.min(270, (avail - laneBase - 24) / branches.length))
          : 150
      // Mind 泳道在脊右侧、分支泳道左侧：脊（leftX）与泳道区（laneBase）的正中。
      const mindLaneX = leftX + (laneBase - leftX) / 2
      const W = Math.max(560, laneBase + branches.length * laneW + 16)

      const timeline = [
        ...turns.map((turn) => ({ kind: 'turn', at: turn.at ?? 0, turn })),
        ...events.map((event) => ({ kind: 'event', at: event.at ?? 0, event })),
        ...mindEvents.map((event, index) => ({ kind: 'mind', at: event.at ?? 0, event, index })),
      ].sort((a, b) => a.at - b.at)
      const rowOf = new Map()
      timeline.forEach((item, index) => {
        rowOf.set(item.kind === 'turn' ? `turn:${item.turn.turn}` : item.kind === 'mind' ? `mind:${item.index}` : `event:${item.event.id}`, index)
      })
      const yOf = (index) => padTop + index * rowGap
      const H = Math.max(padTop + timeline.length * rowGap + 30, 200)
      const laneIndex = new Map(branches.map((branch, index) => [branch.id, index]))
      const laneX = (index) => laneBase + index * laneW + laneW / 2
      const eventRow = (id) => rowOf.get(`event:${id}`)
      const laneTop = (branch) => yOf(eventRow(`fork:${branch.id}`) ?? 0)
      const laneBottom = (branch) => {
        const mergeRow = eventRow(`merge:${branch.id}`)
        return mergeRow === undefined ? H - 30 : yOf(mergeRow)
      }
      const links = (graph?.links ?? []).filter(
        (link) => link?.kind === 'shared-fact' && Array.isArray(link.between) && link.between.every((id) => laneIndex.has(id)),
      )

      const marks = []
      // 画布内头部：脊/时间/Mind 道/泳道标题（轮次窗口与图例在画布外，见 legendBar）。
      marks.push(h('text', { key: 'lbl-l', x: leftX - 40, y: 18, fontSize: 11, fill: C.muted }, t('graph.spineTurns')))
      marks.push(h('text', { key: 'time', x: leftX + 12, y: 18, fontSize: 11, fill: C.muted }, '时间 ↓'))
      // 空态：两线之间没有任何往来（links 为空、也没有汇回/放弃事件）时，
      // 泳道区给一行淡字，有内容就不显示——如实说空，不硬凑。
      if (links.length === 0 && !events.some((event) => event.kind === 'merge' || event.kind === 'abandon')) {
        const laneEnd = laneBase + branches.length * laneW
        const lowestForkY = Math.max(...branches.map((branch) => laneTop(branch)))
        marks.push(
          h(
            'text',
            {
              key: 'nolinks',
              'data-miopiik-no-links': '1',
              x: (laneBase + laneEnd) / 2,
              y: Math.min(lowestForkY + 20, H - 26),
              textAnchor: 'middle',
              fontSize: 11,
              fill: C.muted,
              opacity: 0.75,
            },
            t('graph.noLinks'),
          ),
        )
      }
      // 左脊：全图唯一用主色的地方。
      marks.push(h('line', { key: 'spine-l', x1: leftX, y1: padTop - 8, x2: leftX, y2: H - 22, stroke: C.brand, strokeWidth: 2.5, strokeLinecap: 'round' }))
      marks.push(
        h('path', {
          key: 'arr-l',
          d: `M ${leftX - 4},${H - 26} L ${leftX},${H - 18} L ${leftX + 4},${H - 26}`,
          fill: 'none',
          stroke: C.brand,
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )

      // Mind 泳道：脊与分支泳道之间的常驻窄道（虚线基线 + 标题），菱形节点按时间落点。
      // 基线用细虚线只是「这里有条道」，不暗示跨度；节点才是动作本身。
      marks.push(h('line', { key: 'mindlane', x1: mindLaneX, y1: padTop - 8, x2: mindLaneX, y2: H - 22, stroke: C.border, strokeWidth: 1, strokeDasharray: '2 4', opacity: 0.5 }))
      marks.push(h('text', { key: 'lbl-mind', x: mindLaneX, y: 18, fontSize: 10, textAnchor: 'middle', fill: C.muted }, t('graph.mindLane')))

      // 每分支一条泳道：底纹、标题、基线、fork 接出（实线）与 merge/abandon 接回（虚线）。
      // 底纹让空白读成「道」而不是「没画完」；选中态给主色淡染，和其余泳道分开。
      for (const [index, branch] of branches.entries()) {
        const x = laneX(index)
        const top = laneTop(branch)
        const bottom = laneBottom(branch)
        const isHot = selected === branch.id
        marks.push(
          h('rect', {
            key: `laneband-${branch.id}`,
            x: x - laneW / 2 + 10,
            y: Math.max(top - 34, 4),
            width: laneW - 20,
            height: Math.min(H - 8, bottom + 16) - Math.max(top - 34, 4),
            rx: 10,
            fill: isHot ? C.brand : C.base,
            fillOpacity: isHot ? 0.08 : 0.75,
          }),
        )
        marks.push(
          h(
            'text',
            { key: `lane-${branch.id}`, x, y: 18, fontSize: 11, textAnchor: 'middle', fill: branch.status === 'open' ? C.text : C.muted },
            `${branch.id} ${String(branch.label).slice(0, 10)}`,
          ),
        )
        marks.push(h('line', { key: `lanebase-${branch.id}`, x1: x, y1: top, x2: x, y2: bottom, stroke: isHot ? C.text : C.border, strokeWidth: isHot ? 1.5 : 1, opacity: isHot ? 0.9 : 0.7 }))
        marks.push(h('path', { key: `forkline-${branch.id}`, d: `M ${leftX},${top} C ${leftX + 60},${top} ${x - 50},${top} ${x - 6},${top}`, fill: 'none', stroke: isHot ? C.text : C.link, strokeWidth: isHot ? 1.5 : 1, opacity: isHot ? 1 : 0.85 }))
        marks.push(h('path', { key: `forkarr-${branch.id}`, d: `M ${x - 7},${top - 4} L ${x},${top} L ${x - 7},${top + 4} Z`, fill: isHot ? C.text : C.link, opacity: isHot ? 1 : 0.9 }))
        const mergeRow = eventRow(`merge:${branch.id}`)
        if (mergeRow !== undefined) {
          const my = yOf(mergeRow)
          marks.push(h('path', { key: `backline-${branch.id}`, d: `M ${x - 6},${my} C ${x - 60},${my} ${leftX + 60},${my} ${leftX + 6},${my}`, fill: 'none', stroke: isHot ? C.text : C.link, strokeWidth: isHot ? 1.5 : 1, strokeDasharray: '4 4', opacity: isHot ? 1 : 0.8 }))
          marks.push(h('path', { key: `backarr-${branch.id}`, d: `M ${leftX + 7},${my - 4} L ${leftX},${my} L ${leftX + 7},${my + 4} Z`, fill: isHot ? C.text : C.link, opacity: isHot ? 1 : 0.9 }))
        }
      }

      // 跨泳道共享事实：细虚线 + 小方块；悬停出事实号，点击去流水溯源。
      for (const [linkIndex, link] of links.entries()) {
        const [a, b] = link.between
        const xa = laneX(laneIndex.get(a))
        const xb = laneX(laneIndex.get(b))
        const y = Math.max(laneTop(branches[laneIndex.get(a)]), laneTop(branches[laneIndex.get(b)])) + 9 + linkIndex * 7
        const mid = (xa + xb) / 2
        marks.push(h('line', { key: `linkvis-${link.factId}-${linkIndex}`, x1: xa, y1: y, x2: xb, y2: y, stroke: C.link, strokeWidth: 1, strokeDasharray: '2 3', opacity: 0.9 }))
        marks.push(h('path', { key: `linkmark-${link.factId}-${linkIndex}`, d: `M ${mid - 3},${y - 3} L ${mid + 3},${y - 3} L ${mid + 3},${y + 3} L ${mid - 3},${y + 3} Z`, fill: C.link, opacity: 0.9 }))
        marks.push(
          h('line', {
            key: `linkhit-${link.factId}-${linkIndex}`,
            x1: xa,
            y1: y,
            x2: xb,
            y2: y,
            stroke: 'transparent',
            strokeWidth: 10,
            'data-miopiik-shared-fact': link.factId,
            style: { cursor: 'pointer' },
            onMouseEnter: () => setHover({ kind: 'link', factId: link.factId, x: mid, y }),
            onMouseLeave: () => setHover(null),
            onClick: () => (typeof onOpenFact === 'function' ? onOpenFact(link.factId) : undefined),
          }),
        )
      }

      // 时间轴行：左脊放轮次圆点，事件落在自己泳道，Mind 手笔落在 Mind 泳道。
      for (const [index, item] of timeline.entries()) {
        const y = yOf(index)
        if (item.kind === 'turn') {
          marks.push(h('circle', { key: `t-${item.turn.turn}`, cx: leftX, cy: y, r: 5, fill: C.brand }))
          marks.push(h('text', { key: `tt-${item.turn.turn}`, x: leftX - 12, y: y + 4, fontSize: 11, fill: C.brand, textAnchor: 'end', fontWeight: 500 }, `第${item.turn.turn}轮`))
          const readable = (item.turn.label ?? '').startsWith('Ciallo') ? '' : (item.turn.label ?? '').slice(0, 18)
          if (readable !== '') marks.push(h('text', { key: `tl-${item.turn.turn}`, x: leftX + 12, y: y + 4, fontSize: 11, fill: C.muted }, readable))
          continue
        }
        if (item.kind === 'mind') {
          // 菱形 = Mind 动作（与圆/方都不同形），主色描边；悬停给 label+refs+时间，点击去流水溯源。
          const event = item.event
          marks.push(
            h('path', {
              key: `m-${item.index}`,
              d: `M ${mindLaneX},${y - 8} L ${mindLaneX + 8},${y} L ${mindLaneX},${y + 8} L ${mindLaneX - 8},${y} Z`,
              fill: C.base,
              stroke: C.brand,
              strokeWidth: 1.8,
              'data-miopiik-mind-node': `${event.kind}:${event.id}`,
              style: { cursor: 'pointer' },
              onMouseEnter: () =>
                setHover({ kind: 'mind', id: event.id, kindName: event.kind, label: event.label ?? null, refs: Array.isArray(event.refs) ? event.refs : [], at: event.at ?? null, x: mindLaneX, y }),
              onMouseLeave: () => setHover(null),
              onClick: () => (typeof onTraceMind === 'function' ? onTraceMind(event) : undefined),
            }),
          )
          continue
        }
        const event = item.event
        const lane = laneIndex.get(event.branchId)
        if (lane === undefined) continue
        const x = laneX(lane)
        const branch = branches[lane]
        const isHot = selected === branch.id
        // Ink/Mind 侧事件 = 圆；执行层（Operator）= 方。形状=层，颜色=状态。
        if (event.kind === 'job') {
          const color = stateColor(event.state)
          const size = isHot ? 14 : 12
          marks.push(
            h('rect', {
              key: `e-${event.id}`,
              x: x - size / 2,
              y: y - size / 2,
              width: size,
              height: size,
              rx: 2,
              fill: event.state === 'running' ? color : C.base,
              fillOpacity: event.state === 'running' ? 1 : 0.35,
              stroke: color,
              strokeWidth: 2,
              'data-miopiik-job-node': event.jobId ?? '',
              style: { cursor: 'pointer' },
              onMouseEnter: () =>
                setHover({ kind: 'job', branchId: branch.id, jobId: event.jobId ?? null, state: event.state ?? null, stopReason: event.stopReason ?? null, label: event.label ?? null, x, y }),
              onMouseLeave: () => setHover(null),
              onClick: () => setSelected(selected === branch.id ? null : branch.id),
            }),
          )
        } else {
          const color = event.kind === 'fork' ? C.text : event.kind === 'merge' ? C.success : C.idle
          marks.push(
            h('circle', {
              key: `e-${event.id}`,
              cx: x,
              cy: y,
              r: isHot ? 7 : 6,
              fill: C.base,
              stroke: color,
              strokeWidth: 1.8,
              style: { cursor: 'pointer' },
              onMouseEnter: () => setHover({ kind: 'branch', branchId: branch.id, x, y }),
              onMouseLeave: () => setHover(null),
              onClick: () => setSelected(selected === branch.id ? null : branch.id),
            }),
          )
        }
      }

      const chosen = selected === null ? null : branches.find((branch) => branch.id === selected) ?? null
      // 悬停气泡：链接给事实号；job 给状态与 stopReason；分支给摘要与进度；
      // Mind 菱形给 label + refs + 时间（§13.10：署名行不用点开就能认出是哪一步）。
      const bubble = (() => {
        if (hover === null) return null
        if (hover.kind === 'link') {
          return { x: Math.max(hover.x - 60, 8), y: Math.max(hover.y - 40, 26), title: `${t('graph.sharedFact')} ${hover.factId}`, lines: [t('graph.sharedFactHint')] }
        }
        if (hover.kind === 'mind') {
          return {
            x: Math.min(Math.max(hover.x - 90, 8), W - 250),
            y: Math.max(hover.y - 40, 26),
            title: hover.label === null || hover.label === '' ? `${hover.id} · ${hover.kindName}` : hover.label,
            lines: [
              (hover.refs ?? []).length > 0 ? `refs: ${hover.refs.join(' ')}` : null,
              hover.at === null || hover.at === undefined ? null : new Date(hover.at).toLocaleString(),
              t('graph.mindHint'),
            ].filter(Boolean),
          }
        }
        const branch = branches.find((entry) => entry.id === hover.branchId)
        if (branch === undefined) return null
        if (hover.kind === 'job') {
          return {
            x: Math.min(Math.max(hover.x - 90, 8), W - 250),
            y: Math.max(hover.y - 44, 26),
            title: `${hover.jobId ?? ''} ${hover.label ?? ''}`,
            lines: [
              `${t('graph.state')}: ${hover.state ?? ''}`,
              hover.stopReason === null || hover.stopReason === undefined ? null : `${t('graph.stopReason')}: ${hover.stopReason}`,
            ].filter(Boolean),
          }
        }
        return {
          x: Math.min(Math.max(hover.x - 90, 8), W - 250),
          y: Math.max(hover.y - 40, 26),
          title: `${branch.id} ${branch.label}`,
          lines: [branch.summary, `${branch.jobs.length} ${t('branches.jobs')} · ${statusLabel(branch)}`].filter(Boolean),
        }
      })()

      // 图例在画布外：形状语言一行说完，窄列自动换行，不再被 viewBox 宽度切边。
      const legendItems = [
        { key: 'fork', kind: 'arc', label: t('graph.legendFork') },
        { key: 'merge', kind: 'arcDashed', label: t('graph.legendMerge') },
        { key: 'shared', kind: 'shared', label: t('graph.legendSharedFact') },
        { key: 'job', kind: 'square', label: t('graph.legendJob') },
        { key: 'event', kind: 'circle', label: t('graph.legendEvent') },
        { key: 'mind', kind: 'diamond', label: t('graph.legendMind') },
      ]
      const legendGlyph = (kind, key) => {
        const children = []
        if (kind === 'arc' || kind === 'arcDashed') {
          children.push(
            h('path', {
              key: 'p',
              d: 'M 1,9 q 10,-8 20,0',
              fill: 'none',
              stroke: C.link,
              strokeWidth: 1.4,
              strokeLinecap: 'round',
              ...(kind === 'arcDashed' ? { strokeDasharray: '4 3' } : {}),
            }),
          )
        } else if (kind === 'shared') {
          children.push(h('line', { key: 'l', x1: 1, y1: 6, x2: 21, y2: 6, stroke: C.link, strokeWidth: 1, strokeDasharray: '2 3', opacity: 0.9 }))
          children.push(h('path', { key: 's', d: 'M 8,3 L 14,3 L 14,9 L 8,9 Z', fill: C.link, opacity: 0.9 }))
        } else if (kind === 'square') {
          children.push(h('rect', { key: 's', x: 7, y: 2, width: 8, height: 8, rx: 2, fill: C.base, fillOpacity: 0.35, stroke: C.text, strokeWidth: 2 }))
        } else if (kind === 'diamond') {
          children.push(h('path', { key: 'd', d: 'M 11,1 L 16,6 L 11,11 L 6,6 Z', fill: C.base, stroke: C.brand, strokeWidth: 1.6 }))
        } else {
          children.push(h('circle', { key: 'c', cx: 11, cy: 6, r: 4.5, fill: C.base, stroke: C.text, strokeWidth: 1.8 }))
        }
        return h('svg', { key, width: 22, height: 12, viewBox: '0 0 22 12', 'aria-hidden': true, style: { flex: 'none' } }, ...children)
      }
      const legendBar = h(
        'div',
        {
          'data-miopiik-legend': 'graph',
          style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 16px', padding: '0 2px 8px', fontSize: 11.5, lineHeight: '16px', color: C.muted },
        },
        h('span', { key: 'window', 'data-miopiik-window': windowLabel, style: { color: C.text, fontWeight: 500, marginRight: 4 } }, windowLabel),
        ...legendItems.map((item) =>
          h(
            'span',
            { key: item.key, 'data-miopiik-legend-item': item.key, style: { display: 'inline-flex', alignItems: 'center', gap: 5 } },
            legendGlyph(item.kind, `${item.key}-glyph`),
            h('span', null, item.label),
          ),
        ),
      )

      return h(
        'div',
        { style: { display: 'flex', minHeight: 0, height: '100%' } },
        h(
          'div',
          { ref: canvasRef, style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 } },
          h(
            'div',
            { style: { flex: 'none', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '14px 20px 6px' } },
            h(CountsStrip, { graph }),
          ),
          h('div', { style: { flex: 'none', padding: '0 20px' } }, legendBar),
          h(
            'div',
            {
              style: {
                flex: '1 1 auto',
                minHeight: 0,
                // 视图容器的高度取决于外层，给一个视口上限才能真的滚起来
                maxHeight: 'calc(100vh - 250px)',
                overflow: 'auto',
                padding: '0 20px 140px',
              },
            },
            h(
              'div',
              {
                style: {
                  position: 'relative',
                  width: '100%',
                  margin: '0 auto',
                  border: `0.5px solid ${C.border}`,
                  borderRadius: 10,
                  background: C.layer1,
                  overflow: 'hidden',
                  padding: '6px 0 10px',
                },
              },
              // 选中分支（细节面板展开）时整图缩宽适配可用列宽：viewBox 不变，
              // width 交给容器（100%），高度按宽高比随动——泳道区不再被面板挤走。
              chosen !== null
                ? h(
                    'svg',
                    {
                      viewBox: `0 0 ${W} ${H}`,
                      width: '100%',
                      role: 'img',
                      'data-miopiik-graph': '1',
                      'aria-label': t('graph.title'),
                      style: { display: 'block', height: 'auto', aspectRatio: `${W} / ${H}` },
                    },
                    ...marks,
                  )
                : h(
                    'svg',
                    {
                      viewBox: `0 0 ${W} ${H}`,
                      width: W,
                      height: H,
                      role: 'img',
                      'data-miopiik-graph': '1',
                      'aria-label': t('graph.title'),
                      style: { display: 'block', margin: '0 auto' },
                    },
                    ...marks,
                  ),
              bubble === null
                ? null
                : h(
                    'div',
                    {
                      style: {
                        position: 'absolute',
                        // 缩宽态（细节面板展开）下画布按百分比铺开，气泡坐标同步用百分比，
                        // 才能钉在缩放后的同一个画布位置上。
                        left: chosen !== null ? `${((Math.min(bubble.x, W - 240) / W) * 100).toFixed(3)}%` : Math.min(bubble.x, W - 240),
                        top: chosen !== null ? `${((Math.max(bubble.y, 0) / H) * 100).toFixed(3)}%` : Math.max(bubble.y, 0),
                        width: 232,
                        padding: '8px 10px',
                        border: `0.5px solid ${C.border}`,
                        borderRadius: 8,
                        background: C.overlay,
                        boxShadow: '0 6px 20px rgba(0,0,0,0.12)',
                        pointerEvents: 'none',
                        fontSize: 11,
                        lineHeight: '17px',
                        color: C.text,
                      },
                    },
                    h('div', { style: { fontWeight: 600, marginBottom: 2 } }, bubble.title),
                    ...bubble.lines.map((line, index) => h('div', { key: index, style: { color: C.muted } }, line)),
                  ),
            ),
          ),
        ),
        chosen !== null
          ? h(
              'aside',
              {
                'data-miopiik-branch-detail': chosen.id,
                style: {
                  flex: '0 0 340px',
                  minHeight: 0,
                  borderLeft: `0.5px solid ${C.border}`,
                  overflow: 'auto',
                  padding: '16px 18px 24px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  background: C.layer1,
                  color: C.text,
                },
              },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
                h('strong', { style: { fontSize: 14 } }, `${chosen.id} ${chosen.label}`),
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => setSelected(null),
                    'aria-label': t('graph.close'),
                    style: { border: 0, background: 'transparent', color: C.muted, cursor: 'pointer', fontSize: 13 },
                  },
                  '×',
                ),
              ),
              typeof onOpenStream === 'function'
                ? h(
                    'button',
                    {
                      type: 'button',
                      onClick: () => onOpenStream(chosen.id),
                      style: {
                        alignSelf: 'flex-start',
                        padding: '3px 10px',
                        border: `0.5px solid ${C.brand}`,
                        borderRadius: 12,
                        background: 'transparent',
                        color: C.brand,
                        cursor: 'pointer',
                        fontSize: 11,
                      },
                    },
                    t('graph.openStream'),
                  )
                : null,
              chosen.summary ? h('div', { style: { fontSize: 12, color: C.muted, lineHeight: '18px' } }, chosen.summary) : null,
              chosen.premise
                ? h('div', { style: { fontSize: 12, lineHeight: '18px' } }, h('span', { style: { color: C.muted } }, `${t('graph.premise')}：`), chosen.premise)
                : null,
              (chosen.quotes ?? []).length > 0
                ? h(
                    'div',
                    { style: { fontSize: 12, lineHeight: '18px' } },
                    h('div', { style: { color: C.muted, marginBottom: 2 } }, t('graph.quotes')),
                    ...chosen.quotes.map((quote, index) =>
                      h('div', { key: index, style: { borderLeft: `2px solid ${C.border}`, paddingLeft: 8, marginBottom: 2 } }, quote),
                    ),
                  )
                : null,
              (chosen.facts ?? []).length > 0
                ? h(
                    'div',
                    { style: { fontSize: 12, lineHeight: '18px' } },
                    h('div', { style: { color: C.muted, marginBottom: 2 } }, t('graph.facts')),
                    h('div', null, chosen.facts.join('、')),
                  )
                : null,
              h('div', { style: { fontSize: 12, color: C.muted } }, t('graph.jobs')),
              ...((chosen.jobs ?? []).length === 0
                ? [h('div', { key: 'nojob', style: { fontSize: 12, color: C.muted } }, t('graph.noJobs'))]
                : chosen.jobs.map((job) => {
                    // 契约目标是派发时定下的（快照只给最近 10 个 job 带契约），查不到就不写。
                    const contract = (snapshot?.audit?.jobs ?? []).find((entry) => entry.id === job.id)?.contract ?? null
                    return h(
                      'div',
                      {
                        key: job.id,
                        'data-miopiik-job': job.id,
                        onClick: () => (typeof onOpenJob === 'function' ? onOpenJob(job.id) : undefined),
                        style: {
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 2,
                          fontSize: 12,
                          cursor: 'pointer',
                          padding: '4px 6px',
                          border: `1px solid ${C.border}`,
                          borderRadius: 6,
                        },
                      },
                      h(
                        'div',
                        { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
                        h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${job.id} ${job.label}`),
                        h('span', { style: { color: stateColor(job.state), flex: 'none' } }, job.state),
                      ),
                      job.stopReason ? h('div', { style: { fontSize: 11, color: C.muted } }, `${t('graph.stopReason')}: ${job.stopReason}`) : null,
                      contract?.goal ? h('div', { style: { fontSize: 11, color: C.muted } }, `${t('graph.contract')}: ${String(contract.goal).slice(0, 60)}`) : null,
                    )
                  })),
              chosen.mergeClaim
                ? h(
                    'div',
                    { style: { fontSize: 12, lineHeight: '18px' } },
                    h('div', { style: { color: C.muted, marginBottom: 2 } }, `${t('graph.merged')}${chosen.mergedInto ? ` ${chosen.mergedInto}` : ''}`),
                    chosen.mergeClaim,
                  )
                : null,
            )
          : null,
      )
    }

    /**
     * MiOpIIk 功能页：唯一入口。上面是页签（鱼骨为主视图），下面是各面板。
     * 原来顶栏胶囊 + 抽屉的入口已合并到这里，避免同一件事有两个入口。
     */
    /**
     * 右栏面板：中间层（Ink）的常驻视图——未结事项、最近决定、运行中。
     * 与 MiOpIIk 页共用同一份投影，只是换个位置常驻。
     */
    function InkPane(props) {
      const { sessionId, useProjection } = props ?? {}
      const snapshot = typeof useProjection === 'function' ? useProjection('miopiikBackstage') : undefined
      const loops = snapshot?.loops?.active ?? []
      const notes = (snapshot?.audit?.notes ?? []).slice(0, 8)
      const running = snapshot?.jobs?.running ?? 0
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12, height: '100%', padding: '14px 16px', background: C.base, color: C.text, overflow: 'auto' } },
        h(
          'div',
          { style: { display: 'flex', gap: 14, fontSize: 11, color: C.muted } },
          h('span', null, `${t('tab.loops')} ${loops.length}`),
          h('span', null, `${t('tab.running')} ${running}`),
          h('span', null, `${t('tab.facts')} ${(snapshot?.facts?.items ?? []).filter(isSettled).length}`),
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { style: { fontSize: 12, fontWeight: 600, color: C.muted } }, t('tab.loops')),
          loops.length === 0
            ? h('div', { style: styles.empty }, t('loops.empty'))
            : loops.slice(0, 6).map((loop) =>
                h('div', { key: loop.id, style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                  h('span', { style: { flex: 'none', fontSize: 11, color: C.brand } }, loop.id),
                  h('span', { style: { fontSize: 12, color: C.text } }, loop.text),
                ),
              ),
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { style: { fontSize: 12, fontWeight: 600, color: C.muted } }, t('rightbar.inbox')),
          (snapshot?.inbox?.previews ?? []).length === 0
            ? h('div', { style: styles.empty }, t('rightbar.inboxEmpty'))
            : (snapshot?.inbox?.previews ?? []).map((item) =>
                h('div', { key: item.id, style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                  h('span', { style: { flex: 'none', fontSize: 10, color: C.brand } }, item.tier),
                  h('span', { style: { flex: '1 1 auto', minWidth: 0, fontSize: 12, color: C.text } }, item.claim),
                  item.question ? h('span', { style: { flex: 'none', fontSize: 11, color: C.muted } }, '→') : null,
                ),
              ),
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { style: { fontSize: 12, fontWeight: 600, color: C.muted } }, t('tab.stream')),
          (() => {
            const merged = [
              ...notes.map((note) => ({ id: note.id, kind: note.kind, claim: note.claim, at: note.at ?? 0 })),
              ...(snapshot?.audit?.factEvents ?? []).map((fact) => ({ id: fact.id, kind: 'fact', claim: fact.claim, at: fact.at ?? 0 })),
              ...(snapshot?.audit?.branchEvents ?? []).map((branch) => ({ id: `ev-${branch.id}`, kind: 'branch', claim: `${branch.id} ${branch.label} · ${branch.status}`, at: branch.at ?? 0 })),
            ].sort((a, b) => b.at - a.at).slice(0, 8)
            return merged.length === 0
              ? h('div', { style: styles.empty }, t('stream.empty'))
              : merged.map((row) =>
                  h('div', { key: row.id, style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                    h('span', { style: { flex: 'none', fontSize: 11, color: row.kind === 'fact' ? C.success : row.kind === 'branch' ? C.brand : C.muted } }, row.kind),
                    h('span', { style: { flex: '1 1 auto', minWidth: 0, fontSize: 12, color: C.text } }, row.claim),
                  ),
                )
          })(),
        ),
      )
    }

    function MiOpIIkView(props) {
      const { sessionId, useProjection } = props ?? {}
      const snapshot = typeof useProjection === 'function' ? useProjection('miopiikBackstage') : undefined
      const [tab, setTab] = React.useState('graph')
      const shellRef = React.useRef(null)
      const [width, setWidth] = React.useState(0)
      React.useEffect(() => {
        const el = shellRef.current
        if (el === null || typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver((entries) => {
          const next = entries[0]?.contentRect?.width ?? 0
          if (next > 0) setWidth(next)
        })
        observer.observe(el)
        return () => observer.disconnect()
      }, [])
      // 这个布局下会话区在 1280 视口只有约 950px，阈值要按实际可用宽度定。
      const wide = width >= 900
      const [streamFilter, setStreamFilter] = React.useState(null) // {branch} | {id, open} | null
      const [focusBranch, setFocusBranch] = React.useState(null)
      const openStream = (branchId) => {
        setStreamFilter({ branch: branchId })
        setTab('stream')
      }
      // 溯源跳转：F-x/L-n/J-n 过滤流水；I-x（open=true）直达那条投递的详情。
      const traceId = (id, open = false) => {
        setStreamFilter(open === true ? { id, open: true } : { id })
        setTab('stream')
      }
      // Mind 泳道菱形的溯源：走同一条 traceId 通道，按账本对象 id 过滤流水。
      const traceMind = (event) => {
        if (typeof event?.id === 'string' && event.id !== '') traceId(event.id)
      }
      const openGraph = (branchId) => {
        setFocusBranch(branchId)
        setTab('graph')
      }
      const tabs = [
        ['graph', t('tab.graph')],
        ...(wide ? [] : [['list', t('tab.list')]]),
        ['stream', t('tab.stream')],
        ['context', t('tab.context')],
      ]
      return h(
        'div',
        {
          ref: shellRef,
          style: {
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            maxHeight: 'calc(100vh - 120px)',
            minHeight: 0,
            background: C.base,
            color: C.text,
            // 缩宽态遮挡修复（§13.10）：DSH 会话壳在视图区上盖一条隐形 col-resize 宽柄
            // （.wSkVaW_widthHandle，position:absolute、z-index:0，贴头部区纵贯整列），
            // aside 展开整图缩宽后，顶部事件节点正好落进这条带上，点击/悬停全被它吃掉。
            // 本视图自提一层（position+zIndex）越过它：壳元素一个不改，指针命中归视图内容。
            position: 'relative',
            zIndex: 1,
          },
        },
        h(
          'div',
          {
            role: 'tablist',
            style: {
              display: 'flex',
              gap: 22,
              padding: '10px 22px 0',
              borderBottom: `0.5px solid ${C.border}`,
              flex: 'none',
            },
          },
          ...tabs.map(([id, label]) =>
            h(
              'button',
              {
                key: id,
                type: 'button',
                role: 'tab',
                'aria-selected': tab === id ? 'true' : 'false',
                onClick: () => setTab(id),
                style: {
                  padding: '0 2px 9px',
                  border: 0,
                  borderBottom: tab === id ? `2px solid ${C.brand}` : '2px solid transparent',
                  background: 'transparent',
                  color: tab === id ? C.brand : C.muted,
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 500,
                  lineHeight: '16px',
                  whiteSpace: 'nowrap',
                },
              },
              label,
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: () => rightbar?.openTab?.('miopiik'),
              title: t('rightbar.open'),
              style: {
                marginLeft: 'auto',
                marginBottom: 9,
                padding: '2px 9px',
                border: `0.5px solid ${C.border}`,
                borderRadius: 12,
                background: 'transparent',
                color: C.muted,
                cursor: 'pointer',
                fontSize: 11,
                whiteSpace: 'nowrap',
              },
            },
            t('rightbar.open'),
          ),
        ),
        h(
          'div',
          { style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: tab === 'graph' ? 0 : '18px 22px' } },
          tab === 'graph'
            ? wide
              ? h(
                  'div',
                  { style: { display: 'flex', minHeight: 0, height: '100%' } },
                  h('div', { style: { flex: '1 1 auto', minWidth: 0, minHeight: 0 } }, h(FishboneView, { ...props, onOpenStream: openStream, onOpenFact: (factId) => traceId(factId), onOpenJob: (jobId) => traceId(jobId), onTraceMind: traceMind, focusBranch })),
                  h(
                    'div',
                    {
                      style: {
                        flex: '0 0 340px',
                        minHeight: 0,
                        overflow: 'auto',
                        borderLeft: `0.5px solid ${C.border}`,
                        padding: '14px 16px 24px',
                        background: C.base,
                      },
                    },
                    h(ListPane, { snapshot, sessionId }),
                  ),
                )
              : h(FishboneView, { ...props, onOpenStream: openStream, onOpenFact: (factId) => traceId(factId), onOpenJob: (jobId) => traceId(jobId), onTraceMind: traceMind, focusBranch })
            : tab === 'list'
              ? h(ListPane, { snapshot, sessionId })
              : tab === 'context'
              ? h(ContextPane, { snapshot, onTraceId: traceId })
              : h(StreamPane, {
                  snapshot,
                  sessionId,
                  filter: streamFilter,
                  onClearFilter: () => setStreamFilter(null),
                  onOpenGraph: openGraph,
                }),
        ),
      )
    }

    function Section({ title, children }) {
      return h(
        'section',
        { style: { display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 18 } },
        h('div', { style: { fontSize: 12, fontWeight: 600, color: C.muted, letterSpacing: 0.2 } }, title),
        children,
      )
    }

    /** 清单：每类状态一张卡片，卡片左侧一道分类色，标题栏带计数。 */
    function ListPane({ snapshot, sessionId }) {
      const loops = snapshot?.loops
      const facts = snapshot?.facts
      const running = snapshot?.jobs
      const drafts = snapshot?.drafts
      const letter = snapshot?.letter
      const cards = [
        {
          key: 'loops',
          title: t('tab.loops'),
          accent: C.brand,
          count: loops?.activeCount ?? loops?.active?.length ?? 0,
          body: h(LoopsPane, { snapshot, sessionId, compact: true }),
        },
        {
          key: 'facts',
          title: t('tab.facts'),
          accent: C.success,
          count: (facts?.items ?? []).filter(isSettled).length,
          body: h(FactsPane, { snapshot, sessionId, compact: true }),
        },
        {
          key: 'running',
          title: t('tab.running'),
          accent: C.warn,
          count: running?.running ?? 0,
          body: h(RunningPane, { snapshot, compact: true }),
        },
        {
          key: 'drafts',
          title: t('tab.drafts'),
          accent: C.idle,
          count: drafts?.open ?? 0,
          body: h(DraftsPane, { snapshot, compact: true }),
        },
        {
          key: 'letter',
          title: t('tab.letter'),
          accent: C.borderStrong,
          count: letter === null || letter === undefined ? 0 : 1,
          body: h(LetterPane, { snapshot, compact: true }),
        },
      ]
      return h(
        'div',
        {
          style: {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: 14,
            alignItems: 'start',
          },
        },
        ...cards.map((card) =>
          h(
            'section',
            {
              key: card.key,
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                padding: '14px 16px 16px',
                background: C.layer1,
                border: `0.5px solid ${C.border}`,
                borderRadius: 10,
                borderTop: `2px solid ${card.accent}`,
                minWidth: 0,
              },
            },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 } },
              h('span', { style: { fontSize: 12, fontWeight: 600, color: C.text, letterSpacing: 0.2 } }, card.title),
              h(
            'span',
            { style: { fontSize: 11, color: card.count > 0 ? card.accent : C.muted, fontVariantNumeric: 'tabular-nums' } },
            card.key === 'facts' && facts?.bytes
              ? `${card.count} · ${(facts.bytes / 1024).toFixed(1)} KB`
              : String(card.count),
          ),
            ),
            card.body,
          ),
        ),
      )
    }

    /**
     * 所见：Mind 这轮真看到的 L3 原文 + 分节现值。
     * 上层与 prompt.js 注入的 miopiik:l3 同一次装配、同一段原文（等宽、原样、可折叠）；
     * 下层按 sections 展示当前已定结论 / 悬着的事 / 收件箱待读，
     * 每行 id 都能点去流水溯源（F-x/L-n 按账本 id，I-x 直达详情）。
     * 旧的装配明细（inkContext head/tail + 候选）收进默认折叠小节。
     */
    function ContextPane({ snapshot, onTraceId }) {
      const l3 = snapshot?.l3
      const inkContext = snapshot?.inkContext
      const candidates = snapshot?.candidates ?? []
      const [l3Open, setL3Open] = React.useState(false)
      const [assemblyOpen, setAssemblyOpen] = React.useState(false)
      // 「Mind 最近动作」：默认收起，交互与「Ink 装配明细」同款（§13.10）。
      const [mindOpen, setMindOpen] = React.useState(false)
      if (l3 === undefined || l3 === null) return h('div', { style: styles.empty }, t('ctx.offline'))
      const facts = l3.sections?.facts ?? []
      const loops = l3.sections?.loops ?? []
      const inbox = l3.sections?.inbox ?? []
      // 最近 8 条 mind 署名行（新者在前）；数据面是 graph.mindEvents 的截窗尾，
      // 推导在 host（SPEC §13.10），这里只做展示，不重复判定。
      const mindRows = (snapshot?.graph?.mindEvents ?? []).slice(-8).reverse()
      const idButton = (id, open = false) =>
        h(
          'button',
          {
            type: 'button',
            'data-miopiik-trace': id,
            title: t('ctx.trace'),
            onClick: () => (typeof onTraceId === 'function' ? onTraceId(id, open) : undefined),
            style: { flex: 'none', border: 0, background: 'transparent', color: C.brand, cursor: 'pointer', fontSize: 11, fontVariantNumeric: 'tabular-nums', padding: 0 },
          },
          id,
        )

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 18, padding: '4px 2px 24px', maxWidth: 780 } },
        h(
          Section,
          { title: t('ctx.l3') },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h(
              'button',
              {
                type: 'button',
                onClick: () => setL3Open(!l3Open),
                style: { ...styles.action, flex: 'none' },
              },
              l3Open ? t('ctx.l3Collapse') : t('ctx.l3Expand'),
            ),
            h('span', { style: styles.meta }, l3.generatedAt ? new Date(l3.generatedAt).toLocaleString() : ''),
            l3Open ? null : h('span', { style: { fontSize: 11.5, color: C.muted } }, t('ctx.l3Hint')),
          ),
          l3Open
            ? l3.text === ''
              ? h('div', { style: styles.empty }, t('ctx.empty'))
              : h(
                  'pre',
                  {
                    'data-miopiik-l3-text': '1',
                    style: {
                      margin: 0,
                      padding: '10px 12px',
                      background: C.layer1,
                      border: `1px solid ${C.border}`,
                      borderRadius: 8,
                      fontSize: 11.5,
                      lineHeight: '18px',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      color: C.text,
                      fontFamily: 'var(--ds-font-family-code, var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace))',
                      maxHeight: 420,
                      overflow: 'auto',
                    },
                  },
                  l3.text,
                )
            : null,
        ),
        facts.length > 0
          ? h(
              Section,
              { title: `${t('ctx.facts')}（${facts.length}）` },
              ...facts.map((fact) =>
                h(
                  'div',
                  { key: fact.id, style: styles.row },
                  h(
                    'div',
                    { style: styles.rowText },
                    fact.claim,
                    h(
                      'div',
                      { style: { display: 'flex', gap: 5, marginTop: 4, flexWrap: 'wrap' } },
                      inkChip(fact.conf, fact.conf === 'high' ? C.success : fact.conf === 'low' ? C.muted : C.warn),
                      inkChip(fact.source, actorColorOf(fact.source) === C.text ? C.muted : actorColorOf(fact.source)),
                      fact.scope === 'workspace' ? inkChip(t('facts.scopeWorkspace'), C.brand) : null,
                      fact.stale === true ? inkChip(t('facts.pending'), C.muted) : null,
                    ),
                  ),
                  idButton(fact.id),
                ),
              ),
            )
          : null,
        loops.length > 0
          ? h(
              Section,
              { title: `${t('ctx.loops')}（${loops.length}）` },
              ...loops.map((loop) =>
                h(
                  'div',
                  { key: loop.id, style: styles.row },
                  h(
                    'div',
                    { style: styles.rowText },
                    loop.text,
                    h(
                      'div',
                      { style: { display: 'flex', gap: 5, marginTop: 4, flexWrap: 'wrap', alignItems: 'center' } },
                      inkChip(loop.type, C.muted),
                      loop.suggestedClose === true ? inkChip(t('ctx.suggestedClose'), C.warn) : null,
                      loop.closureCondition === null || loop.closureCondition === undefined
                        ? null
                        : h('span', { style: { fontSize: 11, color: C.muted } }, `${t('graph.closure')}: ${loop.closureCondition}`),
                    ),
                  ),
                  idButton(loop.id),
                ),
              ),
            )
          : null,
        inbox.length > 0
          ? h(
              Section,
              { title: `${t('ctx.inbox')}（${inbox.length}）` },
              ...inbox.map((item) =>
                h(
                  'div',
                  { key: item.id, style: styles.row },
                  h(
                    'div',
                    { style: styles.rowText },
                    `${item.tier} ${item.claim}`,
                    h('div', { style: styles.meta }, item.question === null || item.question === undefined ? '' : `→ ${item.question}`),
                  ),
                  idButton(item.id, true),
                ),
              ),
            )
          : null,
        mindRows.length > 0
          ? h(
              Section,
              { title: t('ctx.mind') },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 10 } },
                h(
                  'button',
                  { type: 'button', onClick: () => setMindOpen(!mindOpen), style: { ...styles.action, flex: 'none' } },
                  mindOpen ? t('ctx.mindCollapse') : t('ctx.mindExpand'),
                ),
                h('span', { style: styles.meta }, t('ctx.mindHint')),
              ),
              mindOpen
                ? h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                    ...mindRows.map((row) =>
                      h(
                        'div',
                        {
                          key: `${row.kind}:${row.id}:${row.at}`,
                          'data-miopiik-mind-row': `${row.kind}:${row.id}`,
                          style: {
                            display: 'flex',
                            gap: 10,
                            alignItems: 'baseline',
                            padding: '7px 10px',
                            background: C.layer1,
                            border: `1px solid ${C.border}`,
                            borderRadius: 6,
                            fontSize: 12,
                          },
                        },
                        h('span', { style: { flex: 'none', fontSize: 10, color: C.brand, minWidth: 88 } }, row.kind),
                        h('span', { style: { flex: '1 1 auto', minWidth: 0, wordBreak: 'break-word' } }, row.label),
                        row.at ? h('span', { style: { flex: 'none', fontSize: 10, color: C.muted } }, new Date(row.at).toLocaleString()) : null,
                        // 只有账本对象 id（B-/L-/J-/I-/F-/P-/A-n）才给溯源按钮；简报行无对象可点，不硬造。
                        /^[A-Z]-\d+$/u.test(String(row.id ?? '')) ? idButton(row.id) : null,
                      ),
                    ),
                  )
                : null,
            )
          : null,
        inkContext === undefined || inkContext === null
          ? null
          : h(
              Section,
              { title: t('ctx.assembly') },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 10 } },
                h(
                  'button',
                  { type: 'button', onClick: () => setAssemblyOpen(!assemblyOpen), style: { ...styles.action, flex: 'none' } },
                  assemblyOpen ? t('ctx.assemblyCollapse') : t('ctx.assemblyExpand'),
                ),
                h('span', { style: styles.meta }, t('ctx.assemblyHint')),
              ),
              assemblyOpen
                ? h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 18 } },
                    h(
                      Section,
                      { title: `${t('ctx.head')}（${inkContext.headChars ?? 0} 字，仅保留最近 ${inkContext.headMax ?? 2000} 字）` },
                      inkContext.head === '' || inkContext.head === undefined
                        ? h('div', { style: styles.empty }, t('ctx.empty'))
                        : h(
                            'div',
                            {
                              style: {
                                fontSize: 12,
                                lineHeight: 1.65,
                                color: C.muted,
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                                background: C.layer1,
                                border: `1px solid ${C.border}`,
                                borderRadius: 8,
                                padding: '10px 12px',
                                maxHeight: 260,
                                overflow: 'auto',
                              },
                            },
                            inkContext.head,
                          ),
                    ),
                    h(
                      Section,
                      { title: `${t('ctx.tail')}（${inkContext.tailCount ?? (inkContext.tail ?? []).length} 条）` },
                      (inkContext.tail ?? []).length === 0
                        ? h('div', { style: styles.empty }, t('ctx.empty'))
                        : h(
                            'div',
                            { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                            ...(inkContext.tail ?? []).map((entry, index) =>
                              h(
                                'div',
                                {
                                  key: `${entry.at ?? index}-${index}`,
                                  style: {
                                    display: 'flex',
                                    gap: 10,
                                    alignItems: 'baseline',
                                    padding: '7px 10px',
                                    background: C.layer1,
                                    border: `1px solid ${C.border}`,
                                    borderRadius: 6,
                                    fontSize: 12,
                                  },
                                },
                                h('span', { style: { fontSize: 10, color: C.muted, minWidth: 56 } }, entry.kind),
                                h('span', { style: { flex: '1 1 auto', wordBreak: 'break-word' } }, entry.text),
                                (entry.refs ?? []).length === 0
                                  ? null
                                  : h('span', { style: { fontSize: 10, color: C.muted } }, (entry.refs ?? []).join(',')),
                              ),
                            ),
                          ),
                    ),
                    h(
                      Section,
                      { title: t('ctx.candidates') },
                      candidates.length === 0
                        ? h('div', { style: styles.empty }, t('ctx.empty'))
                        : h(
                            'div',
                            { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                            ...candidates.map((entry) =>
                              h(
                                'div',
                                {
                                  key: entry.id,
                                  style: {
                                    padding: '8px 10px',
                                    background: C.layer1,
                                    border: `1px solid ${C.border}`,
                                    borderRadius: 6,
                                    fontSize: 12,
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: 3,
                                  },
                                },
                                h('div', {}, entry.claim),
                                entry.question === null
                                  ? null
                                  : h('div', { style: { fontSize: 11, color: C.muted } }, `→ ${entry.question}`),
                              ),
                            ),
                          ),
                    ),
                  )
                : null,
            ),
      )
    }

    /**
     * 流水：后台做过的每一件可重建操作。
     * 首屏 = 投影尾窗（snapshot.audit 的最近采样，零延迟）；
     * 「更早」经 /miopiik audit 命令通道翻全史——游标 (before, beforeSeq)
     * 保证从最新无缺口翻到最早，连点合并进在飞的那一页、只追加不刷屏；
     * kind 过滤器按命令返回的行生成（服务端 kind=…）；溯源过滤（F-x/L-n/I-x/J-n）
     * 是本地 id/refs 匹配；命令通道不可用时如实降级：显示到尾窗为止。
     */
    /** 流水行的 kind 说人话；字典里没有的原样保留（如实露出账本词，不硬编）。 */
    function streamKindLabel(kind) {
      const key = `stream.kind.${String(kind ?? '')}`
      const label = t(key)
      return label === key ? String(kind ?? '') : label
    }

    function StreamPane({ snapshot, sessionId, filter = null, onClearFilter, onOpenGraph }) {
      const audit = snapshot?.audit
      const [server, setServer] = React.useState(null) // { rows, cursor, params } | null = 尾窗模式
      const [busy, setBusy] = React.useState(false)
      const [degraded, setDegraded] = React.useState(null)
      const [kind, setKind] = React.useState('all')
      const [query, setQuery] = React.useState('')
      const [open, setOpen] = React.useState(null)
      const inFlight = React.useRef(false)
      const bootRef = React.useRef(null)
      const autoOpenRef = React.useRef(false)

      const branchParam = typeof filter?.branch === 'string' && filter.branch !== '' ? filter.branch : null
      const traceIdParam = typeof filter?.id === 'string' && filter.id !== '' ? filter.id : null

      /**
       * 取一页装进视图。base = null 重建（换过滤条件），base = 已装行则顺着游标续翻。
       * 在飞期间再点会被吞进当前这一页（合并请求，不刷屏）。
       */
      const fetchPageInto = async (base, { kindParam = null, branch = branchParam } = {}) => {
        if (inFlight.current === true) return { skipped: true }
        inFlight.current = true
        setBusy(true)
        setDegraded(null)
        try {
          const cursor = base === null ? null : base.cursor
          const line = auditLine({ ...(cursorParams(cursor) ?? {}), kind: kindParam, branch })
          const outcome = await fetchAuditPage(sessionId, line)
          if (outcome.error !== undefined) {
            setDegraded(outcome.error)
            return { error: outcome.error }
          }
          const merged = mergeAuditPage(base, outcome.page)
          setServer({ rows: merged.rows, cursor: merged.cursor, params: { kind: kindParam, branch } })
          return { merged }
        } finally {
          inFlight.current = false
          setBusy(false)
        }
      }

      /** 溯源对象可能在更早的页里：顺序翻页直到它出现（封顶 8 页，不全史倒腾）。 */
      const loadTrace = async (id) => {
        let base = null
        for (let pages = 0; pages < 8; pages += 1) {
          const step = await fetchPageInto(base, {})
          if (step.merged === undefined) return
          base = { rows: step.merged.rows, cursor: step.merged.cursor }
          if (base.rows.some((row) => rowTracesTo(row, id)) || base.cursor === null) return
        }
      }

      // 到达过滤（分支 / 溯源）时自动接上命令通道：溯源要的是真实事件行，尾窗给不了。
      React.useEffect(() => {
        const key = `${branchParam ?? ''}|${traceIdParam ?? ''}`
        if (key === bootRef.current) return
        const prev = bootRef.current
        bootRef.current = key
        if (branchParam !== null) {
          void fetchPageInto(null, { kindParam: null, branch: branchParam })
          return
        }
        if (traceIdParam !== null && server === null) {
          void loadTrace(traceIdParam)
          return
        }
        if (traceIdParam === null && prev !== null && prev.split('|')[0] !== '') {
          // 分支过滤被清掉：回到尾窗首屏，已装的分支过滤行不再冒充无过滤视图。
          setServer(null)
          setKind('all')
        }
      })

      const baseRows = server !== null ? server.rows : tailRows(audit)
      const needle = query.trim().toLowerCase()
      const visibleRows = baseRows
        .filter((row) => (branchParam !== null ? row.branch === branchParam : true))
        .filter((row) => (traceIdParam !== null ? rowTracesTo(row, traceIdParam) : true))
        .filter((row) =>
          needle === '' ? true : `${row.claim} ${row.detail ?? ''} ${row.branch ?? ''} ${row.kind}`.toLowerCase().includes(needle),
        )
      // 行 id 不唯一（同一对象的多条操作行共用 id），用 id|kind|at 加序号消重。
      const keyed = []
      const seenKeys = new Map()
      for (const row of visibleRows) {
        const base = `${row.id}|${row.kind}|${row.at}`
        const nth = (seenKeys.get(base) ?? 0) + 1
        seenKeys.set(base, nth)
        keyed.push({ row, key: nth === 1 ? base : `${base}#${nth}` })
      }

      // 收件箱溯源（I-x）自动展开那条投递的详情。
      React.useEffect(() => {
        if (traceIdParam === null || filter?.open !== true || autoOpenRef.current === true) return
        const hit = keyed.find((entry) => entry.row.id === traceIdParam && entry.row.kind === 'inbox.deliver')
        if (hit === undefined) return
        autoOpenRef.current = true
        setOpen(hit.key)
      })

      const kinds = server === null ? [] : [...new Set(server.rows.map((row) => row.kind))]
      const chosen = open === null ? null : keyed.find((entry) => entry.key === open) ?? null

      if (audit === undefined || audit === null) return h('div', { style: styles.empty }, t('stream.offline'))

      const obs = audit.observations ?? {}
      const clearChip = (chip) =>
        h(
          'button',
          {
            type: 'button',
            title: t('stream.clearTrace'),
            onClick: () => (typeof onClearFilter === 'function' ? onClearFilter() : undefined),
            style: { padding: '3px 9px', border: `0.5px solid ${C.brand}`, borderRadius: 12, background: C.brand, color: '#fff', cursor: 'pointer', fontSize: 11 },
          },
          chip,
        )

      return h(
        'div',
        { style: { display: 'flex', gap: 16, alignItems: 'flex-start' } },
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            branchParam !== null ? clearChip(`${branchParam} ×`) : null,
            traceIdParam !== null ? clearChip(`${traceIdParam} ×`) : null,
            ...['all', ...kinds].map((entry) =>
              h(
                'button',
                {
                  key: entry,
                  type: 'button',
                  onClick: () => {
                    setKind(entry)
                    void fetchPageInto(null, { kindParam: entry === 'all' ? null : entry, branch: branchParam })
                  },
                  'aria-pressed': kind === entry ? 'true' : 'false',
                  style: {
                    padding: '3px 9px',
                    border: `0.5px solid ${kind === entry ? C.brand : C.border}`,
                    borderRadius: 12,
                    background: 'transparent',
                    color: kind === entry ? C.brand : C.muted,
                    cursor: 'pointer',
                    fontSize: 11,
                  },
                },
                entry === 'all'
                  ? `${t('stream.all')} ${server === null ? baseRows.length : server.rows.length}`
                  : `${streamKindLabel(entry)} ${server?.rows.filter((row) => row.kind === entry).length ?? 0}`,
              ),
            ),
            h('input', {
              value: query,
              onChange: (event) => setQuery(event.target.value),
              placeholder: t('stream.search'),
              style: {
                flex: '0 0 160px',
                marginLeft: 'auto',
                padding: '4px 10px',
                border: `0.5px solid ${C.border}`,
                borderRadius: 12,
                background: 'transparent',
                color: C.text,
                fontSize: 11,
                outline: 'none',
              },
            }),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 18, fontSize: 11, color: C.muted, flexWrap: 'wrap', alignItems: 'center' } },
            h('span', null, `${t('stream.observed')} ${obs.user ?? 0} / ${obs.assistant ?? 0} / ${obs.tool ?? 0}`),
            server === null ? h('span', null, t('stream.tailHint')) : h('span', null, `${t('stream.loaded')} ${server.rows.length}`),
            degraded === null
              ? null
              : h('span', { style: { color: C.error } }, `${degraded}${server === null ? ` · ${t('stream.tailOnly')}` : ''}`),
            server !== null && server.cursor === null
              ? h('span', null, t('stream.exhausted'))
              : h(
                  'button',
                  {
                    type: 'button',
                    disabled: busy,
                    onClick: () => {
                      if (server === null) {
                        void fetchPageInto(null, { kindParam: null, branch: branchParam })
                        return
                      }
                      void fetchPageInto({ rows: server.rows, cursor: server.cursor }, { kindParam: server.params.kind, branch: server.params.branch })
                    },
                    style: { ...styles.action, flex: 'none', color: busy ? C.muted : C.text },
                  },
                  busy ? t('stream.busy') : t('stream.earlier'),
                ),
          ),
          keyed.length === 0
            ? h('div', { style: styles.empty }, t('stream.empty'))
            : keyed.map(({ row, key }) =>
                h(
                  'div',
                  {
                    key,
                    'data-miopiik-row': key,
                    onClick: () => setOpen(open === key ? null : key),
                    style: {
                      display: 'flex',
                      gap: 10,
                      alignItems: 'baseline',
                      padding: '6px 4px',
                      margin: '0 -4px',
                      borderRadius: 6,
                      borderBottom: `0.5px solid ${C.border}`,
                      cursor: 'pointer',
                      background: open === key ? C.layer1 : 'transparent',
                    },
                  },
                  h(
                    'span',
                    { style: { flex: 'none', width: 56, fontSize: 11, color: C.muted, fontVariantNumeric: 'tabular-nums' } },
                    row.at ? new Date(row.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '',
                  ),
                  h(
                    'span',
                    {
                      'data-miopiik-kind': row.kind,
                      title: row.kind,
                      style: {
                        flex: 'none',
                        width: 84,
                        fontSize: 11,
                        color: row.rowKind === 'job' ? C.warn : row.rowKind === 'fact' ? C.success : row.rowKind === 'branch' ? C.brand : C.muted,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      },
                    },
                    streamKindLabel(row.kind),
                  ),
                  h('span', { style: { flex: '1 1 auto', minWidth: 0, fontSize: 12, color: C.text } }, row.claim),
                  row.branch ? h('span', { style: { flex: 'none', fontSize: 11, color: C.muted } }, row.branch) : null,
                  // 行面小签放在行尾：行内前三格（时间/kind/结论）次序不动，既有消费不破。
                  h(ActorChip, { actor: row.actor }),
                ),
              ),
        ),
        chosen === null ? null : h(StreamDetail, { row: chosen.row, onClose: () => setOpen(null), onOpenGraph }),
      )
    }

    /** 点开的详情：把这条记录里能看的都放出来，不截断成一行。 */
    function StreamDetail({ row, onClose, onOpenGraph }) {
      const block = (label, value) =>
        value === null || value === undefined || value === ''
          ? null
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h('div', { style: { fontSize: 11, color: C.muted } }, label),
              h('div', { style: { fontSize: 12, color: C.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: '18px' } }, value),
            )
      return h(
        'aside',
        {
          style: {
            flex: '0 0 380px',
            maxHeight: 'calc(100vh - 260px)',
            overflow: 'auto',
            border: `0.5px solid ${C.border}`,
            borderRadius: 10,
            background: C.layer1,
            padding: '14px 16px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            color: C.text,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
          h('strong', { style: { fontSize: 13 } }, `${row.id} · ${row.kindLabel ?? row.kind}`),
          h('button', { type: 'button', onClick: onClose, 'aria-label': t('graph.close'), style: { border: 0, background: 'transparent', color: C.muted, cursor: 'pointer', fontSize: 13 } }, '×'),
        ),
        block(t('stream.detailClaim'), row.claim),
        block('why', row.why),
        block(t('stream.detailQuestion'), row.question),
        row.detail
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h('div', { style: { fontSize: 11, color: C.muted } }, t('stream.detailBody')),
              h('pre', {
                style: { margin: 0, padding: '8px 10px', background: C.base, border: `0.5px solid ${C.border}`, borderRadius: 6, fontSize: 11, lineHeight: '17px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: C.text, fontFamily: 'inherit' },
              }, row.detail),
            )
          : null,
        row.job && row.job.contract
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { style: { fontSize: 11, color: C.muted } }, t('stream.contract')),
              block(t('stream.detailGoal'), row.job.contract.goal),
              block(t('stream.detailDeliverables'), row.job.contract.deliverables),
              block(t('stream.detailAcceptance'), row.job.contract.acceptance),
              block(t('stream.detailBoundary'), row.job.contract.boundary),
              block(t('stream.detailBudget'), row.job.contract.budget),
            )
          : null,
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: C.muted } },
          (row.refs ?? []).length > 0 ? h('span', null, `refs: ${row.refs.join(' ')}`) : null,
          row.actor ? h('span', null, `actor: ${row.actor}`) : null,
          Number.isFinite(row.day) ? h('span', null, `day: ${row.day}`) : null,
          (row.loops ?? []).length > 0 ? h('span', null, `loops: ${row.loops.join(' ')}`) : null,
          row.conf ? h('span', null, `conf: ${row.conf}`) : null,
          row.rowKind === 'job' && row.job ? h('span', null, `state: ${row.job.state}${row.job.stopReason ? ` · ${row.job.stopReason}` : ''}`) : null,
          typeof row.visibleToUser === 'boolean' ? h('span', null, row.visibleToUser ? '已对用户可见' : '未展示') : null,
          row.branch ? h('span', null, `branch: ${row.branch}`) : null,
        ),
        row.branch && typeof onOpenGraph === 'function'
          ? h(
              'button',
              { type: 'button', onClick: () => onOpenGraph(row.branch), style: { alignSelf: 'flex-start', padding: '3px 10px', border: `0.5px solid ${C.brand}`, borderRadius: 12, background: 'transparent', color: C.brand, cursor: 'pointer', fontSize: 11 } },
              t('stream.openGraph'),
            )
          : null,
      )
    }

    function LoopsPane({ snapshot, sessionId, compact = false }) {
      const loops = snapshot?.loops
      if (loops === undefined) return h('div', { style: styles.empty }, t('loops.offline'))
      const active = loops.active ?? []
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        compact ? null : h('div', { style: styles.meta }, t('loops.subtitle')),
        active.length === 0
          ? h('div', { style: styles.empty }, t('loops.empty'))
          : active.map((loop) =>
              h(
                'div',
                { key: loop.id, style: styles.row },
                h(
                  'div',
                  { style: styles.rowText },
                  loop.text,
                  h('div', { style: styles.meta }, loop.id),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    style: styles.action,
                    onClick: () => runBackstageCommand(sessionId, `/miopiik loop close ${loop.id}`),
                  },
                  t('loops.close'),
                ),
              ),
            ),
        h('div', { style: styles.meta }, `${t('loops.dormant')} ${loops.dormant ?? 0} · ${t('loops.closed')} ${loops.closed ?? 0}`),
      )
    }

    /** 事实分两档：用户说过的 / 高置信的算「已定」，其余只能在「待核」里等确认。 */
    function isSettled(fact) {
      return fact.source === 'user' || fact.conf === 'high'
    }

    function FactRow({ fact, sessionId }) {
      return h(
        'div',
        { style: styles.row },
        h(
          'div',
          { style: styles.rowText },
          fact.claim,
          h('div', { style: styles.meta }, `${fact.id} · ${fact.conf} · ${fact.source} · ${fact.scope === 'workspace' ? t('facts.scopeWorkspace') : t('facts.scopeSession')}`),
        ),
        h(
          'button',
          {
            type: 'button',
            style: styles.action,
            onClick: () => runBackstageCommand(sessionId, `/miopiik fact invalidate ${fact.id}`),
          },
          t('facts.invalidate'),
        ),
      )
    }

    function FactsPane({ snapshot, sessionId, compact = false }) {
      const facts = snapshot?.facts
      if (facts === undefined) return h('div', { style: styles.empty }, t('facts.offline'))
      const items = facts.items ?? []
      const settled = items.filter(isSettled)
      const pending = items.filter((fact) => !isSettled(fact))
      if (items.length === 0) {
        return h('div', { style: styles.empty }, t('facts.empty'))
      }
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        compact ? null : h('div', { style: styles.meta }, t('facts.subtitle')),
        settled.length > 0
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, ...settled.map((fact) => h(FactRow, { key: fact.id, fact, sessionId })))
          : null,
        pending.length > 0
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: settled.length > 0 ? 6 : 0 } },
              h('div', { style: { fontSize: 11, color: C.muted } }, t('facts.pending')),
              ...pending.map((fact) => h(FactRow, { key: fact.id, fact, sessionId })),
            )
          : null,
      )
    }

    function RunningPane({ snapshot, compact = false }) {
      const jobs = snapshot?.jobs
      if (jobs === undefined) return h('div', { style: styles.empty }, t('running.offline'))
      const items = jobs.items ?? []
      const branches = snapshot?.branches?.items ?? []
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        compact ? null : h('div', { style: styles.meta }, t('running.subtitle')),
        items.length === 0
          ? h('div', { style: styles.empty }, t('running.empty'))
          : items.map((job) =>
              h(
                'div',
                { key: job.id, style: styles.row },
                h(
                  'div',
                  { style: styles.rowText },
                  job.label,
                  h('div', { style: styles.meta }, job.id),
                ),
              ),
            ),
        h('div', { style: styles.meta }, t('branches.title')),
        branches.length === 0
          ? h('div', { style: styles.empty }, t('branches.empty'))
          : branches.map((branch) =>
              h(
                'div',
                { key: branch.id, style: styles.row },
                h(
                  'div',
                  { style: styles.rowText },
                  branch.label,
                  h(
                    'div',
                    { style: styles.meta },
                    `${branch.id} · ${branch.summary || t('branches.noSummary')} · ${branch.jobs} ${t('branches.jobs')}`,
                  ),
                ),
              ),
            ),
      )
    }

    function DraftsPane({ snapshot, compact = false }) {
      const drafts = snapshot?.drafts?.items ?? []
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        compact ? null : h('div', { style: styles.meta }, t('drafts.subtitle')),
        drafts.length === 0
          ? h('div', { style: styles.empty }, t('drafts.empty'))
          : drafts.map((draft) =>
              h(
                'div',
                { key: draft.id, style: styles.row },
                h(
                  'div',
                  { style: styles.rowText },
                  draft.title,
                  h('div', { style: styles.meta }, `${draft.id} · ${draft.conf}`),
                ),
              ),
            ),
      )
    }

    function LetterField({ label, value }) {
      if (!value) return null
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
        h('div', { style: styles.meta }, label),
        h('div', { style: styles.rowText }, value),
      )
    }

    function LetterPane({ snapshot, compact = false }) {
      const letter = snapshot?.letter ?? null
      if (letter === null) {
        return h('div', { style: styles.empty }, t('letter.empty'))
      }
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        compact ? null : h('div', { style: styles.meta }, t('letter.subtitle')),
        h(LetterField, { label: t('letter.progress'), value: letter.progress }),
        h(LetterField, { label: t('letter.loops'), value: letter.loops }),
        h(LetterField, { label: t('letter.running'), value: letter.running }),
        h(LetterField, { label: t('letter.drafts'), value: letter.drafts }),
        h(LetterField, { label: t('letter.next'), value: letter.next }),
        ...letter.updates.map((update, index) =>
          h(LetterField, { key: index, label: t('letter.update'), value: update.text }),
        ),
      )
    }

    function AuditPane({ snapshot }) {
      const notes = snapshot?.audit?.notes ?? []
      if (notes.length === 0) return h('div', { style: styles.empty }, t('audit.empty'))
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('div', { style: styles.meta }, t('audit.subtitle')),
        notes.map((note) =>
          h(
            'div',
            { key: note.id, style: styles.row },
            h(
              'div',
              { style: styles.rowText },
              note.claim,
              h('div', { style: styles.meta }, `${note.id} · ${note.kind}`),
            ),
          ),
        ),
      )
    }


    // 官方插件管理页只声明 plugins.bundle.config 一个配置 slot；MiOpIIk 的
    // 介绍与配置都收在这一个 slot 里：上面一句话介绍，下面 4 个真实生效的控件。
    // 控件数据来自 DSH settings 服务（configForms.get('miopiik-dsh')），保存走
    // mutate → Host 落盘 profile patch 层 → volatile 引用原位更新，免重启生效。
    const MIO_PLUGIN_ENTRY = 'miopiik-dsh'

    // 4 个实时生效的配置项；键与 host/config-defaults.js 的 VOLATILE_KEYS 一致，
    // test/settings.test.js 会校验两边不漂移。
    const MIO_FIELDS = [
      ['conversationCompile', '回合结束静默提炼结论与未结事项', 'checkbox'],
      ['operatorModel', 'Operator 派发模型（provider/model；留空跟随会话）', 'text'],
      ['activeLoopCap', '活跃未结事项上限', 'number'],
      ['operatorTimeoutMs', 'Operator 任务超时阈值（毫秒）', 'number'],
    ]

    const MIO_INTRO =
      'MiOpIIk 把状态记账与后台执行从对话中解耦：Mind 只负责与你交流，Ink 在回合边界静默提炼结论与未结事项，Operator 按契约在后台推进长耗时任务。'

    // 页面只使用 DSH 的设计 token，浅色/深色由主题决定；没有品牌渐变和大卡片。
    const MIO_PAGE = {
      root: {
        display: 'flex', flexDirection: 'column', gap: 24,
        width: '100%', minWidth: 0, boxSizing: 'border-box',
        color: 'var(--dsw-alias-label-primary)',
      },
      // 上下两大块（介绍 / 配置）各自的容器，块内节奏与根一致。
      part: { display: 'flex', flexDirection: 'column', gap: 24, minWidth: 0 },
      section: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 },
      title: { margin: 0, fontSize: 14, fontWeight: 500, lineHeight: '20px' },
      body: {
        margin: 0, fontSize: 14, lineHeight: '22px',
        color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere',
      },
      hint: {
        margin: 0, fontSize: 12, lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere',
      },
      list: { margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', minWidth: 0 },
      item: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 8, flexWrap: 'wrap', padding: '9px 2px', minWidth: 0,
        borderTop: '.5px solid var(--dsw-alias-border-l2)',
      },
      itemMain: { display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 220px', minWidth: 0 },
      itemLabel: { fontSize: 13, fontWeight: 500, lineHeight: '20px' },
      itemKey: {
        fontFamily: 'var(--ds-font-family-code, var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace))',
        fontSize: 11.5, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)',
        overflowWrap: 'anywhere',
      },
      badge: {
        alignSelf: 'flex-start', flex: 'none',
        border: '.5px solid var(--dsw-alias-border-l2)', borderRadius: 6,
        padding: '0 6px', fontSize: 11, lineHeight: '16px',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      fieldControls: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      input: {
        height: 28, padding: '0 8px', minWidth: 160, maxWidth: '100%',
        border: '.5px solid var(--dsw-alias-border-l4)', borderRadius: 'var(--dsw-radius-md)',
        background: 'transparent', color: 'var(--dsw-alias-label-primary)',
        font: 'inherit', fontSize: 12.5,
      },
      checkbox: { width: 16, height: 16, margin: 0, accentColor: 'var(--dsw-alias-brand-primary)' },
      actions: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
    }

    // 复用官方 primitives 的按钮；加载不到时退回同 token 的普通元素，
    // 页面仍然可用，也不会伪造官方 API。
    let MIO_PRIMITIVES = null
    try {
      MIO_PRIMITIVES = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      MIO_PRIMITIVES = null
    }
    const MioButton = MIO_PRIMITIVES?.Button

    function MioActionButton({ onClick, disabled = false, children }) {
      if (MioButton) return h(MioButton, { variant: 'outline', size: 'sm', onClick, disabled }, children)
      return h(
        'button',
        {
          type: 'button',
          onClick,
          disabled,
          style: {
            height: 28, padding: '0 10px',
            border: '.5px solid var(--dsw-alias-border-l4)',
            borderRadius: 'var(--dsw-radius-md)', background: 'transparent',
            color: 'var(--dsw-alias-label-secondary)', font: 'inherit', fontSize: 12.5,
            cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
          },
        },
        children,
      )
    }

    // settings 服务接入的落点：formStore 里是 configForms.get('miopiik-dsh')
    // 返回的 form（snapshot/subscribe/mutate），没有该服务时为 null。
    const formStore = createStore(null)

    function MioFieldRow({ field, value, overridden, disabled, onChange, onReset }) {
      const [key, label, kind] = field
      const common = { 'data-miopiik-input': key, disabled, onChange }
      const control =
        kind === 'checkbox'
          ? h('input', {
              ...common,
              type: 'checkbox',
              checked: value === true,
              style: MIO_PAGE.checkbox,
            })
          : h('input', {
              ...common,
              type: kind === 'number' ? 'number' : 'text',
              value: value === undefined || value === null ? '' : String(value),
              placeholder: kind === 'text' ? '留空跟随会话' : undefined,
              style: MIO_PAGE.input,
            })
      return h(
        'div',
        { 'data-miopiik-field': key, style: MIO_PAGE.item },
        h(
          'div',
          { style: MIO_PAGE.itemMain },
          h('span', { style: MIO_PAGE.itemLabel }, label),
          h('code', { style: MIO_PAGE.itemKey }, key),
          overridden ? h('span', { 'data-miopiik-overridden': key, style: MIO_PAGE.badge }, '已覆盖') : null,
        ),
        h(
          'div',
          { style: MIO_PAGE.fieldControls },
          control,
          overridden && !disabled ? h(MioActionButton, { onClick: onReset }, '恢复默认') : null,
        ),
      )
    }

    // 插件页一个面说完：上面一句话介绍（是什么），下面 4 个真实控件（改了就生效）。
    // hook 次数不随 form 在场与否变化：无服务时挂空订阅，读取保持稳定。
    const MIO_NULL_SUBSCRIBE = () => () => {}
    const MIO_NULL_SNAPSHOT = () => null

    function MioPluginPage() {
      const form = useStore(formStore)
      const snap = React.useSyncExternalStore(
        form === null ? MIO_NULL_SUBSCRIBE : form.subscribe,
        form === null ? MIO_NULL_SNAPSHOT : form.getSnapshot,
      )
      const [edits, setEdits] = React.useState({})
      const [saving, setSaving] = React.useState(false)
      const [statusLine, setStatusLine] = React.useState('')

      const ready = snap?.status === 'ready'
      const hasEdit = (key) => Object.prototype.hasOwnProperty.call(edits, key)
      const valueOf = (key) => (hasEdit(key) ? edits[key] : ready ? snap.value?.[key] : undefined)
      const overridden = (key) =>
        ready && snap.user !== null && typeof snap.user === 'object' && Object.prototype.hasOwnProperty.call(snap.user, key)
      const invalidNumber = MIO_FIELDS.some(([key, , kind]) => kind === 'number' && hasEdit(key) && !Number.isFinite(Number(edits[key])))
      const dirty = Object.keys(edits).length > 0
      const writable = snap?.writable === true

      const edit = (key, value) => setEdits((prev) => ({ ...prev, [key]: value }))

      const save = async () => {
        if (form === null || !writable || saving || invalidNumber || !dirty) return
        const ops = []
        for (const [key, , kind] of MIO_FIELDS) {
          if (!hasEdit(key)) continue
          if (kind === 'number') {
            const parsed = Number(edits[key])
            if (Number.isFinite(parsed)) ops.push({ op: 'set', path: [key], value: parsed })
          } else if (kind === 'checkbox') {
            ops.push({ op: 'set', path: [key], value: edits[key] === true })
          } else {
            const text = String(edits[key] ?? '').trim()
            ops.push(text === '' ? { op: 'unset', path: [key] } : { op: 'set', path: [key], value: text })
          }
        }
        if (ops.length === 0) return
        setSaving(true)
        try {
          const accepted = await form.mutate(ops, snap.revision)
          if (accepted) {
            setEdits({})
            setStatusLine('已保存，即时生效')
          } else {
            setStatusLine('保存被拒绝，配置已刷新为当前值')
          }
        } catch (error) {
          setStatusLine(`保存失败：${String(error?.message ?? error).slice(0, 80)}`)
        } finally {
          setSaving(false)
        }
      }

      const resetEdits = () => {
        setEdits({})
        setStatusLine('')
      }

      const resetField = async (key) => {
        if (form === null || !writable || saving) return
        setSaving(true)
        try {
          const accepted = await form.mutate([{ op: 'unset', path: [key] }], snap.revision)
          if (accepted) {
            // 撤掉该字段的本地草稿（真删除，不留 undefined 占位），显示回折后的当前值。
            setEdits((prev) => {
              const next = { ...prev }
              delete next[key]
              return next
            })
          }
          setStatusLine(accepted ? '已恢复默认值' : '恢复被拒绝，配置已刷新为当前值')
        } catch (error) {
          setStatusLine(`恢复默认失败：${String(error?.message ?? error).slice(0, 80)}`)
        } finally {
          setSaving(false)
        }
      }

      let configuration
      if (form === null) {
        configuration = h('p', { style: MIO_PAGE.hint }, '此部署未提供 DSH 设置服务（configForms），无法实时读写配置。')
      } else if (!ready) {
        configuration = h(
          'p',
          { style: MIO_PAGE.hint },
          snap?.status === 'unavailable'
            ? '当前部署未暴露 miopiik-dsh 的配置命名空间。'
            : '正在读取当前配置…',
        )
      } else {
        configuration = h(
          'div',
          { style: MIO_PAGE.section },
          h('p', { style: MIO_PAGE.hint }, '以下改动经 DSH 设置服务实时读写，保存后免重启生效。'),
          h(
            'div',
            { style: MIO_PAGE.list },
            MIO_FIELDS.map((field) => {
              const [key, , kind] = field
              return h(MioFieldRow, {
                key,
                field,
                value: valueOf(key),
                overridden: overridden(key),
                disabled: saving || !writable,
                onChange: (event) =>
                  edit(key, kind === 'checkbox' ? event?.target?.checked === true : (event?.target?.value ?? '')),
                onReset: () => resetField(key),
              })
            }),
          ),
          h(
            'div',
            { style: MIO_PAGE.actions },
            h(
              MioActionButton,
              { onClick: save, disabled: saving || !writable || !dirty || invalidNumber },
              saving ? '保存中…' : '保存',
            ),
            h(MioActionButton, { onClick: resetEdits, disabled: saving || !dirty }, '重置'),
            statusLine === ''
              ? null
              : h('span', { role: 'status', 'data-miopiik-form-status': '1', style: MIO_PAGE.hint }, statusLine),
          ),
        )
      }

      return h(
        'div',
        { 'data-miopiik-settings': '1', style: MIO_PAGE.root },
        h('div', { 'data-miopiik-overview': '1', style: MIO_PAGE.part }, h('p', { style: MIO_PAGE.body }, MIO_INTRO)),
        h('div', { 'data-miopiik-configuration': '1', style: MIO_PAGE.part }, configuration),
      )
    }

    const zh = {
      'presence.label': '后台任务',
      'presence.title': '打开后台面板',
      'drawer.title': '后台',
      'drawer.close': '关闭',
      'drawer.hint': '面板仅汇总后台整理的信息；任务执行细节不会进入对话。',
      'tab.loops': '未结事项',
      'tab.facts': '已定结论',
      'tab.running': '运行中',
      'tab.drafts': '草稿',
      'tab.letter': '交接记录',
      'view.miopiik': 'MiOpIIk',
      'tab.graph': '鱼骨',
      'tab.list': '清单',
      'tab.stream': '流水',
      'tab.context': '所见',
      'ctx.l3': '后台所见（L3 原文）',
      'ctx.l3Expand': '展开原文',
      'ctx.l3Collapse': '收起原文',
      'ctx.l3Hint': 'Mind 每轮看见的后台摘要；点开逐字读原文。',
      'ctx.facts': '已定结论（现值）',
      'ctx.loops': '悬着的事（活跃）',
      'ctx.inbox': '收件箱待读',
      'ctx.trace': '去流水溯源',
      'ctx.suggestedClose': 'Ink 提示：看似已解',
      'ctx.assembly': 'Ink 装配明细',
      'ctx.assemblyExpand': '展开明细',
      'ctx.assemblyCollapse': '收起明细',
      'ctx.assemblyHint': '装配 L3 的原始材料（head/tail/候选），默认折叠。',
      'ctx.mind': 'Mind 最近动作',
      'ctx.mindExpand': '展开明细',
      'ctx.mindCollapse': '收起明细',
      'ctx.mindHint': '最近 8 条 Mind 署名行（账本推导）；默认折叠。',
      'ctx.head': '折叠头部',
      'ctx.tail': '尾部',
      'ctx.candidates': '对话编译候选',
      'ctx.empty': '还没有内容。',
      'ctx.offline': '后台还没准备好。',
      'rightbar.title': 'Ink',
      'rightbar.inbox': '收件箱（未读）',
      'rightbar.inboxEmpty': '没有待读的预览。',
      'rightbar.open': '在右侧栏打开',
      'tab.audit': '审计',
      'graph.title': '鱼骨图',
      'graph.empty': '还没有分支。',
      'graph.close': '关闭详情',
      'graph.premise': '前提',
      'graph.quotes': '引用',
      'graph.facts': '依赖事实',
      'graph.jobs': '任务',
      'graph.noJobs': '这个分支上没有任务。',
      'graph.merged': '汇回',
      'graph.openStream': '在流水中查看',
      'graph.recentTurns': '最近轮次',
      'graph.allTurns': '全部轮次',
      'graph.spineTurns': '对话',
      'graph.sharedFact': '共享事实',
      'graph.sharedFactHint': '两条分支都依赖这张卡；点击去流水溯源。',
      'graph.abandoned': '已放弃',
      'graph.open': '进行中',
      'graph.state': '状态',
      'graph.stopReason': '停止原因',
      'graph.contract': '契约目标',
      'graph.closure': '闭合条件',
      'graph.legendFork': '实线弧=接出',
      'graph.legendMerge': '虚线弧=接回',
      'graph.legendSharedFact': '横虚线+小方块=共享事实',
      'graph.legendJob': '方=Operator 任务',
      'graph.legendEvent': '圆=Ink 事件',
      'graph.legendMind': '菱形=Mind 动作',
      'graph.mindLane': 'Mind 手笔',
      'graph.mindHint': 'Mind 在主对话里的手笔；点击去流水溯源。',
      'graph.noLinks': '两线之间暂无往来',
      'stream.empty': '后台还没有做过任何决定。',
      'stream.all': '全部',
      'stream.search': '搜结论或分支',
      'stream.observed': '观测（用户/回复/工具）',
      'stream.decisions': '决定',
      'stream.earlier': '更早',
      'stream.busy': '取数中…',
      'stream.exhausted': '已翻到最早',
      'stream.tailHint': '首屏是最近采样；点「更早」翻全史。',
      'stream.tailOnly': '只能看到这批尾窗采样',
      'stream.noChannel': '命令通道不可用',
      'stream.badPage': '返回的不是分页 JSON',
      'stream.loaded': '已装载',
      'stream.clearTrace': '清掉过滤',
      'stream.openGraph': '回到鱼骨查看',
      'stream.contract': '派出去的契约',
      'stream.detailClaim': '结论',
      'stream.detailQuestion': '准备问的',
      'stream.detailBody': '正文（全文）',
      'stream.detailGoal': '目标',
      'stream.detailDeliverables': '交付',
      'stream.detailAcceptance': '验收',
      'stream.detailBoundary': '边界',
      'stream.detailBudget': '预算',

      'stream.kind.absorb': '吸收',
      'stream.kind.preview': '待读预览',
      'stream.kind.note': '笔记',
      'stream.kind.fact.sample': '结论现状',
      'stream.kind.fact.add': '落结论',
      'stream.kind.fact.revise': '修订结论',
      'stream.kind.fact.invalidate': '结论失效',
      'stream.kind.branch.sample': '鱼骨现状',
      'stream.kind.branch.open': '开分支',
      'stream.kind.branch.merge': '并入主干',
      'stream.kind.branch.abandon': '放弃分支',
      'stream.kind.job.sample': '任务现状',
      'stream.kind.job.dispatch': '派发',
      'stream.kind.job.update': '任务进展',
      'stream.kind.loop.add': '登记开环',
      'stream.kind.loop.close': '闭合开环',
      'stream.kind.loop.drop': '丢弃开环',
      'stream.kind.loop.touch': '触碰开环',
      'stream.kind.inbox.deliver': '投递',
      'stream.kind.inbox.read': '已读',
      'stream.kind.inbox.open': '打开',
      'stream.kind.inbox.supersede': '取代',
      'stream.kind.fold.compaction': '折叠压缩',
      'stream.kind.epoch': '换纪元',
      'stream.kind.commit': '提交门',
      'stream.kind.branch.fork': '开分支',
      'stream.kind.branch.context': '分支上下文',
      'stream.kind.branch.summary': '分支摘要',
      'stream.kind.branch.attach-job': '挂任务',
      'stream.kind.fold.propose': '折叠提议',
      'stream.kind.fold.apply': '折叠落地',
      'stream.kind.fold.reject': '折叠退回',
      'stream.kind.briefing': '交接',
      'stream.kind.briefing.overnight': '夜间更新',
      'stream.kind.draft.add': '立草稿',
      'stream.kind.draft.settle': '草稿结算',
      'stream.kind.job.timeout': '任务超时',
      'stream.kind.fact.revise': '修订结论',

      // §13.11 对话里的手笔：工具行与命令行的人话（名词 · 动词 · 对象）。
      'ink.noun.status': '后台总览',
      'ink.noun.loops': '开环',
      'ink.noun.facts': '事实卡',
      'ink.noun.inbox': '收件箱',
      'ink.noun.dispatch': '派发',
      'ink.noun.commit': '提交门',
      'ink.noun.brief': '交接',
      'ink.noun.epoch': '换纪元',
      'ink.noun.draft': '草稿',
      'ink.noun.ask': '问 Ink',
      'ink.noun.report': '交结论',
      'ink.noun.branch': '鱼骨',
      'ink.noun.fold': '折叠',
      'ink.noun.recall': '回溯',
      'ink.act.list': '清单',
      'ink.act.get': '查看',
      'ink.act.add': '新增',
      'ink.act.touch': '触碰',
      'ink.act.close': '闭合',
      'ink.act.drop': '丢弃',
      'ink.act.open': '打开',
      'ink.act.read': '读了',
      'ink.act.star': '加星',
      'ink.act.unstar': '撤星',
      'ink.act.defer': '推后',
      'ink.act.revise': '修订',
      'ink.act.invalidate': '标废',
      'ink.act.merge': '并入',
      'ink.act.abandon': '放弃',
      'ink.act.summary': '摘要',
      'ink.act.context': '上下文',
      'ink.act.propose': '提议',
      'ink.act.review': '验收',
      'ink.act.approve': '通过',
      'ink.act.reject': '否决',
      'ink.act.materials': '取材料',
      'ink.act.save': '保存',
      'ink.act.latest': '最近一份',
      'ink.act.advance': '推进',
      'ink.row.failed': '没做成',
      'ink.row.preparing': '准备中…',
      'ink.row.running': '进行中…',
      'ink.row.approved': '行',
      'ink.row.rejected': '不行',
      'ink.row.stale': '已失效',
      'ink.cmd.audit': '账本翻页',
      'ink.cmd.rows': '行',
      'ink.cmd.loopClose': '划掉开环',
      'ink.cmd.loopDrop': '丢弃开环',
      'ink.cmd.factInvalidate': '标废事实',
      'ink.row.count': '条',
      'ink.row.dispatched': '派出',
      'ink.zone.unread': '待读',
      'ink.zone.history': '历史',
      'ink.zone.starred': '加星',
      'ink.status.active': '活跃',
      'ink.status.dormant': '休眠',
      'ink.status.closed': '已闭',
      'ink.status.stale': '失效',
      'ink.status.pending': '待读',
      'ink.status.cap': '上限',
      'ink.status.notes': '笔记',
      'ink.status.observations': '观测',
      'ink.status.position': '位置',
      'ink.field.goal': '目标',
      'ink.field.deliverables': '交付',
      'ink.field.acceptance': '验收',
      'ink.field.acceptanceSample': '验收样本',
      'ink.field.boundary': '边界',
      'ink.field.budget': '预算',
      'ink.field.claim': '结论',
      'ink.field.evidence': '证据',
      'ink.field.conf': '置信',
      'ink.field.title': '标题',
      'ink.field.summary': '说明',
      'ink.field.draftId': '草稿',
      'ink.field.question': '问题',
      'ink.field.note': '说明',
      'ink.field.text': '内容',
      'ink.field.type': '类型',
      'ink.field.pointer': '出处',
      'ink.field.closureCondition': '闭合条件',
      'ink.field.provenance': '来历',
      'ink.field.source': '来源',
      'ink.field.validUntil': '有效期',
      'ink.field.label': '名字',
      'ink.field.premise': '前提',
      'ink.field.quotes': '原话',
      'ink.field.detail': '依据',
      'ink.field.archive': '归档',
      'ink.field.artifact': '落盘位置',
      'ink.field.progress': '完成',
      'ink.field.running': '在跑',
      'ink.field.drafts': '草稿',
      'ink.field.next': '下一步',
      'ink.field.query': '关键词',
      'ink.field.entity': '实体',
      'ink.field.sinceDay': '起始天',
      'ink.field.read': '回读',
      'ink.field.jobId': '任务号',
      'ink.field.loopId': '开环号',
      'ink.field.provider': '模型',
      'ink.field.loop': '开环',
      'ink.field.fact': '结论',
      'ink.field.branch': '分支',
      'ink.field.proposal': '提案',
      'ink.field.draft': '草稿',
      'ink.field.briefing': '交接',
      'ink.field.job': '任务',
      'ink.field.item': '条目',
      'ink.field.hits': '命中',
      'ink.field.previews': '预览',
      'ink.field.items': '条目',
      'ink.field.proposals': '提案',
      'ink.field.drafts': '草稿',
      'ink.field.count': '条数',
      'ink.field.settled': '处理',
      'ink.field.zone': '区',
      'ink.field.approved': '结果',
      'ink.field.ok': '完成',
      'ink.field.branches': '分支',
      'ink.field.loops': '开环',
      'ink.field.facts': '结论',
      'ink.field.problems': '问题',
      'ink.field.settlements': '结算',
      'ink.field.detailRef': '详情指针',
      'ink.field.epoch': '纪元',
      'ink.field.session': '会话',
      'ink.field.observations': '观测',
      'ink.field.day': '天',
      'ink.field.turn': '轮',

      'actor.mind': 'Mind',
      'actor.ink': 'Ink',
      'actor.operator': 'Operator',
      'actor.user': 'user',
      'actor.mindHint': 'Mind 的手笔（主对话里的决定）',
      'actor.inkHint': 'Ink 的自动结算（回合边界静默落账）',
      'actor.operatorHint': 'Operator 的执行落账',

      'stream.offline': '该会话的后台尚未连接。',
      'count.loops': '未结事项',
      'count.facts': '已定结论',
      'count.running': '运行中',
      'count.drafts': '草稿',
      'loops.subtitle': '对话中尚未收尾的事项。关闭一项无需说明，后续由系统处理。',
      'loops.empty': '当前没有未结事项。',
      'loops.offline': '该会话的后台尚未连接。',
      'loops.close': '关闭',
      'loops.dormant': '休眠',
      'loops.closed': '已关闭',
      'facts.subtitle': '你确认过、或高置信的结论。标记失效比重新解释更省事。',
      'facts.pending': '待核（低置信或只有后台推断，尚未与你确认）',
      'facts.scopeWorkspace': '跨会话',
      'facts.scopeSession': '本会话',
      'facts.empty': '尚无已记录的结论。',
      'facts.offline': '该会话的后台尚未连接。',
      'facts.invalidate': '标记失效',
      'running.subtitle': '后台当前任务；执行细节不会进入对话。',
      'running.empty': '当前没有运行中的任务。',
      'running.offline': '该会话的后台尚未连接。',
      'branches.title': '关联分支（由对话中的具体问题派生）',
      'branches.empty': '当前没有分支。',
      'branches.noSummary': '尚未填写摘要',
      'branches.jobs': '个任务',
      'drafts.subtitle': '未达交付标准的半成品；七天无人处理将自动过期。',
      'drafts.empty': '当前没有草稿。',
      'letter.subtitle': '当日收尾时留下的交接记录。',
      'letter.empty': '今日尚未生成交接记录。',
      'letter.progress': '已完成',
      'letter.loops': '未结事项',
      'letter.running': '运行中',
      'letter.drafts': '草稿',
      'letter.next': '下一步',
      'letter.update': '夜间更新',
      'audit.entry': '审计',
      'audit.back': '收起审计',
      'audit.subtitle': '后台决策记录（审计用途）。',
      'audit.empty': '尚无决策记录。',
    }

    const en = {
      'tab.graph': 'Fishbone',
      'tab.list': 'List',
      'tab.stream': 'Stream',
      'tab.context': 'Seen',
      'ctx.l3': 'What Mind sees (L3 verbatim)',
      'ctx.l3Expand': 'Expand text',
      'ctx.l3Collapse': 'Collapse text',
      'ctx.l3Hint': 'Backstage summary Mind sees each turn; open it for the verbatim text.',
      'ctx.facts': 'Settled conclusions (current)',
      'ctx.loops': 'Open items (active)',
      'ctx.inbox': 'Inbox to read',
      'ctx.trace': 'Trace in stream',
      'ctx.suggestedClose': 'Ink hint: looks resolved',
      'ctx.assembly': 'Ink assembly detail',
      'ctx.assemblyExpand': 'Expand',
      'ctx.assemblyCollapse': 'Collapse',
      'ctx.assemblyHint': 'Raw materials of the L3 assembly (head/tail/candidates); collapsed by default.',
      'ctx.mind': "Mind's recent actions",
      'ctx.mindExpand': 'Expand',
      'ctx.mindCollapse': 'Collapse',
      'ctx.mindHint': 'The last 8 Mind-signed rows (derived from the ledger); collapsed by default.',
      'ctx.head': 'Folded head',
      'ctx.tail': 'Tail',
      'ctx.candidates': 'Conversation candidates',
      'ctx.empty': 'Nothing yet.',
      'ctx.offline': 'Backstage is not ready.',
      'rightbar.title': 'Ink',
      'rightbar.inbox': '收件箱（未读）',
      'rightbar.inboxEmpty': '没有待读的预览。',
      'rightbar.open': 'Open in sidebar',
      'presence.label': 'Backstage',
      'presence.title': 'Open the backstage panel',
      'drawer.title': 'Backstage',
      'drawer.close': 'Close',
      'drawer.hint': 'This panel only summarizes what the backstage prepared; execution details never enter the conversation.',
      'tab.loops': 'Open items',
      'tab.facts': 'Settled facts',
      'tab.running': 'Running',
      'tab.drafts': 'Drafts',
      'tab.letter': 'Handoff record',
      'view.miopiik': 'MiOpIIk',
      'tab.graph': '鱼骨',
      'tab.list': '清单',
      'tab.stream': '流水',
      'rightbar.title': 'Ink',
      'rightbar.inbox': '收件箱（未读）',
      'rightbar.inboxEmpty': '没有待读的预览。',
      'rightbar.open': '在右侧栏打开',
      'tab.audit': 'Audit',
      'graph.title': 'Fishbone graph',
      'graph.empty': 'No branches yet.',
      'graph.close': 'Close details',
      'graph.premise': 'Premise',
      'graph.quotes': 'Quotes',
      'graph.facts': 'Facts',
      'graph.jobs': 'Jobs',
      'graph.noJobs': 'No jobs on this branch.',
      'graph.merged': 'Merged',
      'graph.openStream': 'Open in stream',
      'graph.recentTurns': 'Recent turns',
      'graph.allTurns': 'All turns',
      'graph.spineTurns': 'Talk',
      'graph.sharedFact': 'Shared fact',
      'graph.sharedFactHint': 'Both branches lean on this card; click to trace it in the stream.',
      'graph.abandoned': 'Abandoned',
      'graph.open': 'In flight',
      'graph.state': 'State',
      'graph.stopReason': 'Stop reason',
      'graph.contract': 'Contract goal',
      'graph.closure': 'Closure condition',
      'graph.legendFork': 'solid arc = fork out',
      'graph.legendMerge': 'dashed arc = merge back',
      'graph.legendSharedFact': 'dashed line + square = shared fact',
      'graph.legendJob': 'square = Operator job',
      'graph.legendEvent': 'circle = Ink event',
      'graph.legendMind': 'diamond = Mind action',
      'graph.mindLane': 'Mind',
      'graph.mindHint': "Mind's own action in this conversation; click to trace it in the stream.",
      'graph.noLinks': 'No exchanges between lanes yet.',
      'stream.empty': 'The backstage has not made any decision yet.',
      'stream.all': 'All',
      'stream.search': 'Search claim or branch',
      'stream.observed': 'Observed (user/reply/tool)',
      'stream.decisions': 'Decisions',
      'stream.earlier': 'Earlier',
      'stream.busy': 'Fetching…',
      'stream.exhausted': 'Reached the earliest',
      'stream.tailHint': 'First screen is a recent sample; press “Earlier” to page the full ledger.',
      'stream.tailOnly': 'only the sampled tail window is available',
      'stream.noChannel': 'command channel unavailable',
      'stream.badPage': 'response is not a page JSON',
      'stream.loaded': 'Loaded',
      'stream.clearTrace': 'Clear filter',
      'stream.openGraph': 'Show in graph',
      'stream.contract': 'Dispatched contract',
      'stream.detailClaim': 'Conclusion',
      'stream.detailQuestion': 'Would ask',
      'stream.detailBody': 'Full text',
      'stream.detailGoal': 'Goal',
      'stream.detailDeliverables': 'Deliverables',
      'stream.detailAcceptance': 'Acceptance',
      'stream.detailBoundary': 'Boundary',
      'stream.detailBudget': 'Budget',

      'stream.kind.absorb': 'absorbed',
      'stream.kind.preview': 'preview',
      'stream.kind.note': 'note',
      'stream.kind.fact.sample': 'fact state',
      'stream.kind.fact.add': 'new fact',
      'stream.kind.fact.revise': 'fact revised',
      'stream.kind.fact.invalidate': 'fact stale',
      'stream.kind.branch.sample': 'branch state',
      'stream.kind.branch.open': 'branch opened',
      'stream.kind.branch.merge': 'merged',
      'stream.kind.branch.abandon': 'abandoned',
      'stream.kind.job.sample': 'job state',
      'stream.kind.job.dispatch': 'dispatched',
      'stream.kind.job.update': 'job update',
      'stream.kind.loop.add': 'loop added',
      'stream.kind.loop.close': 'loop closed',
      'stream.kind.loop.drop': 'loop dropped',
      'stream.kind.loop.touch': 'loop touched',
      'stream.kind.inbox.deliver': 'delivered',
      'stream.kind.inbox.read': 'read',
      'stream.kind.inbox.open': 'opened',
      'stream.kind.inbox.supersede': 'superseded',
      'stream.kind.fold.compaction': 'fold compacted',
      'stream.kind.epoch': 'new epoch',
      'stream.kind.commit': 'commit gate',
      'stream.kind.branch.fork': 'branch opened',
      'stream.kind.branch.context': 'branch context',
      'stream.kind.branch.summary': 'branch summary',
      'stream.kind.branch.attach-job': 'job attached',
      'stream.kind.fold.propose': 'fold proposed',
      'stream.kind.fold.apply': 'fold applied',
      'stream.kind.fold.reject': 'fold rejected',
      'stream.kind.briefing': 'handoff',
      'stream.kind.briefing.overnight': 'overnight update',
      'stream.kind.draft.add': 'draft added',
      'stream.kind.draft.settle': 'draft settled',
      'stream.kind.job.timeout': 'job timeout',
      'stream.kind.fact.revise': 'fact revised',

      // §13.11 conversation-side handwritings: human labels for tool rows and command rows.
      'ink.noun.status': 'Backstage',
      'ink.noun.loops': 'Open threads',
      'ink.noun.facts': 'Facts',
      'ink.noun.inbox': 'Inbox',
      'ink.noun.dispatch': 'Dispatch',
      'ink.noun.commit': 'Commit gate',
      'ink.noun.brief': 'Handoff',
      'ink.noun.epoch': 'Epoch',
      'ink.noun.draft': 'Drafts',
      'ink.noun.ask': 'Ask Ink',
      'ink.noun.report': 'Report back',
      'ink.noun.branch': 'Fishbone',
      'ink.noun.fold': 'Fold',
      'ink.noun.recall': 'Recall',
      'ink.act.list': 'list',
      'ink.act.get': 'view',
      'ink.act.add': 'add',
      'ink.act.touch': 'touch',
      'ink.act.close': 'close',
      'ink.act.drop': 'drop',
      'ink.act.open': 'open',
      'ink.act.read': 'read',
      'ink.act.star': 'star',
      'ink.act.unstar': 'unstar',
      'ink.act.defer': 'defer',
      'ink.act.revise': 'revise',
      'ink.act.invalidate': 'invalidate',
      'ink.act.merge': 'merge',
      'ink.act.abandon': 'abandon',
      'ink.act.summary': 'summary',
      'ink.act.context': 'context',
      'ink.act.propose': 'propose',
      'ink.act.review': 'review',
      'ink.act.approve': 'approve',
      'ink.act.reject': 'reject',
      'ink.act.materials': 'materials',
      'ink.act.save': 'save',
      'ink.act.latest': 'latest',
      'ink.act.advance': 'advance',
      'ink.row.failed': 'failed',
      'ink.row.preparing': 'preparing…',
      'ink.row.running': 'running…',
      'ink.row.approved': 'approved',
      'ink.row.rejected': 'rejected',
      'ink.row.stale': 'stale',
      'ink.cmd.audit': 'Ledger page',
      'ink.cmd.rows': 'rows',
      'ink.cmd.loopClose': 'Close thread',
      'ink.cmd.loopDrop': 'Drop thread',
      'ink.cmd.factInvalidate': 'Invalidate fact',
      'ink.row.count': 'items',
      'ink.row.dispatched': 'dispatched',
      'ink.zone.unread': 'unread',
      'ink.zone.history': 'history',
      'ink.zone.starred': 'starred',
      'ink.status.active': 'active',
      'ink.status.dormant': 'dormant',
      'ink.status.closed': 'closed',
      'ink.status.stale': 'stale',
      'ink.status.pending': 'pending',
      'ink.status.cap': 'cap',
      'ink.status.notes': 'notes',
      'ink.status.observations': 'observations',
      'ink.status.position': 'Position',
      'ink.field.goal': 'Goal',
      'ink.field.deliverables': 'Deliverables',
      'ink.field.acceptance': 'Acceptance',
      'ink.field.acceptanceSample': 'Sample',
      'ink.field.boundary': 'Boundary',
      'ink.field.budget': 'Budget',
      'ink.field.claim': 'Claim',
      'ink.field.evidence': 'Evidence',
      'ink.field.conf': 'Confidence',
      'ink.field.title': 'Title',
      'ink.field.summary': 'Summary',
      'ink.field.draftId': 'Draft',
      'ink.field.question': 'Question',
      'ink.field.note': 'Note',
      'ink.field.text': 'Text',
      'ink.field.type': 'Type',
      'ink.field.pointer': 'Pointer',
      'ink.field.closureCondition': 'Closure condition',
      'ink.field.provenance': 'Provenance',
      'ink.field.source': 'Source',
      'ink.field.validUntil': 'Valid until',
      'ink.field.label': 'Label',
      'ink.field.premise': 'Premise',
      'ink.field.quotes': 'Quotes',
      'ink.field.detail': 'Detail',
      'ink.field.archive': 'Archive',
      'ink.field.artifact': 'Artifact',
      'ink.field.progress': 'Progress',
      'ink.field.running': 'Running',
      'ink.field.drafts': 'Drafts',
      'ink.field.next': 'Next',
      'ink.field.query': 'Query',
      'ink.field.entity': 'Entity',
      'ink.field.sinceDay': 'Since day',
      'ink.field.read': 'Read back',
      'ink.field.jobId': 'Job',
      'ink.field.loopId': 'Thread',
      'ink.field.provider': 'Model',
      'ink.field.loop': 'Thread',
      'ink.field.fact': 'Fact',
      'ink.field.branch': 'Branch',
      'ink.field.proposal': 'Proposal',
      'ink.field.draft': 'Draft',
      'ink.field.briefing': 'Handoff',
      'ink.field.job': 'Job',
      'ink.field.item': 'Item',
      'ink.field.hits': 'Hits',
      'ink.field.previews': 'Previews',
      'ink.field.items': 'Items',
      'ink.field.proposals': 'Proposals',
      'ink.field.drafts': 'Drafts',
      'ink.field.count': 'Count',
      'ink.field.settled': 'Settled',
      'ink.field.zone': 'Zone',
      'ink.field.approved': 'Approved',
      'ink.field.ok': 'OK',
      'ink.field.branches': 'Branches',
      'ink.field.loops': 'Threads',
      'ink.field.facts': 'Facts',
      'ink.field.problems': 'Problems',
      'ink.field.settlements': 'Settlements',
      'ink.field.detailRef': 'Detail ref',
      'ink.field.epoch': 'Epoch',
      'ink.field.session': 'Session',
      'ink.field.observations': 'Observations',
      'ink.field.day': 'Day',
      'ink.field.turn': 'Turn',

      'actor.mind': 'Mind',
      'actor.ink': 'Ink',
      'actor.operator': 'Operator',
      'actor.user': 'user',
      'actor.mindHint': "Mind's hand (a decision made in the conversation)",
      'actor.inkHint': "Ink's automatic bookkeeping (settled silently at turn boundaries)",
      'actor.operatorHint': "Operator's execution record",

      'stream.offline': 'The backstage for this session is not connected yet.',
      'count.loops': 'Open',
      'count.facts': 'Facts',
      'count.running': 'Running',
      'count.drafts': 'Drafts',
      'loops.subtitle': 'Items in this conversation that are not closed yet. Closing one needs no explanation.',
      'loops.empty': 'No open items right now.',
      'loops.offline': 'The backstage for this session is not connected yet.',
      'loops.close': 'Close',
      'loops.dormant': 'dormant',
      'loops.closed': 'closed',
      'facts.subtitle': 'Conclusions you confirmed, or high-confidence ones. Invalidating one beats explaining again.',
      'facts.pending': 'Unconfirmed (low confidence or backstage inference only)',
      'facts.scopeWorkspace': 'workspace',
      'facts.scopeSession': 'this conversation',
      'facts.empty': 'No settled facts recorded yet.',
      'facts.offline': 'The backstage for this session is not connected yet.',
      'facts.invalidate': 'Invalidate',
      'running.subtitle': 'Current backstage tasks; execution details stay out of the conversation.',
      'running.empty': 'No task is running right now.',
      'running.offline': 'The backstage for this session is not connected yet.',
      'branches.title': 'Related branches (derived from a specific point in the conversation)',
      'branches.empty': 'No branches right now.',
      'branches.noSummary': 'no summary yet',
      'branches.jobs': 'tasks',
      'drafts.subtitle': 'Work below the delivery bar; untouched for seven days and it expires.',
      'drafts.empty': 'No drafts right now.',
      'letter.subtitle': 'The handoff record left when the day wrapped up.',
      'letter.empty': 'No handoff record for today yet.',
      'letter.progress': 'Completed',
      'letter.loops': 'Open items',
      'letter.running': 'Running',
      'letter.drafts': 'Drafts',
      'letter.next': 'Next',
      'letter.update': 'Overnight update',
      'audit.entry': 'Audit',
      'audit.back': 'Hide audit',
      'audit.subtitle': 'Backstage decision records (audit use).',
      'audit.empty': 'No decisions recorded yet.',
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands'],
      apply(ctx) {
        clientCtx = ctx
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'miopiik: dictionaries')
        t = ctx.locale.bind(NS)


        // 插件页是唯一说明面：介绍与配置都收在这一个 slot 里，
        // 不在「设置 → 内置插件」里占坑。
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            { name: 'plugins.bundle.config', key: 'miopiik-dsh' },
            () => h(MioPluginPage),
          ),
        )

        // 配置页的数据面：settings 服务在位时接入 configForms（snapshot/subscribe/mutate）。
        // 包一层稳定闭包（不依赖 this、函数身份不随渲染变化），没有该服务的部署
        // 照常装载本插件，页面退回为一条静态提示。
        ctx.inject(['configForms'], (scope) => {
          try {
            const raw = scope?.configForms?.get?.(MIO_PLUGIN_ENTRY) ?? null
            formStore.set(
              raw === null
                ? null
                : {
                    subscribe: (listener) => raw.subscribe(listener),
                    getSnapshot: () => raw.getSnapshot(),
                    mutate: (ops, revision) => raw.mutate(ops, revision),
                  },
            )
          } catch {
            formStore.set(null)
          }
          return () => formStore.set(null)
        })

        // 右栏常驻面板：Ink 的视角。类型注册 + 正文席位 + 控制器引用（按钮用它 openTab）。
        ctx.inject(['sidebarRightTabs'], (inner) => {
          inner.effect(
            () =>
              inner.sidebarRightTabs.register({
                id: INK_TAB_ID,
                kind: 'miopiik',
                title: () => t('rightbar.title'),
                keepMounted: true,
              }),
            'miopiik-dsh: rightbar tab type',
          )
          inner.slots.inject('sidebar.right.pane.tab', () =>
            inner.slots.register({ name: 'sidebar.right.pane.tab', key: INK_TAB_ID, locale: NS }, InkPane),
          )
        })
        ctx.inject(['sidebarRight'], (inner) => {
          rightbar = inner.sidebarRight
        })

        // 唯一入口：会话视图里的一个功能页（与「对话 / 轨迹」并列），图与各面板都在这一页里。
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            { name: 'conversation.view', id: 'miopiik', order: 20, locale: NS, label: () => t('view.miopiik') },
            MiOpIIkView,
          ),
        )

        // 对话里我们自己手笔的包装（§13.11）：14 个 ink_* 工具行 + `miopiik` 命令行。
        // 两个席位分别由 ui-tool / ui-chat 声明；inject 等到位再注册，缺席时
        // 其余部分照常装载（退回 DSH 的通用卡，不伪造内容）。
        ctx.slots.inject('tool.call.toolview', () => {
          const disposers = INK_TOOL_NAMES.map((key) =>
            ctx.slots.register({ name: 'tool.call.toolview', key }, InkToolRow),
          )
          return () => {
            for (const dispose of disposers) dispose?.()
          }
        })
        ctx.slots.inject('conversation.chat.commandview', () =>
          ctx.slots.register({ name: 'conversation.chat.commandview', key: 'miopiik' }, MiCommandRow),
        )
      },
    }
  },
})
