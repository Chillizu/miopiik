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
     * 鱼骨图：主干是对话轮次（竖直），分支从某一轮分叉出去、横向走一段，
     * 最后用一条曲线汇回主干——跟 git graph 的 fork / commit / merge 是同一套读法。
     * 所有标签直接画在图上（分支名、任务数、汇回 note 号），不做悬浮提示。
     */
    /**
     * 鱼骨主视图：按事件布局（只画分叉/任务/汇回），不按轮次铺格子。
     * 悬停出详情气泡，点击进入右侧详情面板。
     */
    function FishboneView(props) {
      const { sessionId, useProjection } = props ?? {}
      const snapshot = typeof useProjection === 'function' ? useProjection('miopiikBackstage') : undefined
      const graph = snapshot?.graph
      const [hover, setHover] = React.useState(null)
      const [selected, setSelected] = React.useState(null)
      const branches = graph?.branches ?? []
      const events = graph?.events ?? []

      if (graph === undefined || events.length === 0) {
        return h('div', { style: { padding: 32, color: C.muted, fontSize: 13 } }, t('graph.empty'))
      }

      // 双脊：左脊=对话轮次，右脊=后台事件；两者按时间合成同一批行，横线把「哪一轮发生了什么」连起来。
      const turns = graph?.turns ?? []
      const padTop = 26
      const rowGap = 30
      const leftX = 96
      const rightX = 430
      const W = 620

      const timeline = [
        ...turns.map((turn) => ({ kind: 'turn', at: turn.at ?? 0, turn })),
        ...events.map((event) => ({ kind: 'event', at: event.at ?? 0, event })),
      ].sort((a, b) => a.at - b.at)

      const rowOf = new Map()
      timeline.forEach((item, index) => {
        rowOf.set(item.kind === 'turn' ? `turn:${item.turn.turn}` : `event:${item.event.id}`, index)
      })
      const yOf = (index) => padTop + index * rowGap
      const H = Math.max(padTop + timeline.length * rowGap + 24, 180)

      // 分支 fork/merge 事件所在行，用于连线与气泡定位
      const eventRow = (id) => rowOf.get(`event:${id}`)

      const marks = []
      // 两条脊
      marks.push(h('line', { key: 'spine-l', x1: leftX, y1: padTop - 8, x2: leftX, y2: H - 22, stroke: C.borderStrong, strokeWidth: 1.5 }))
      marks.push(h('line', { key: 'spine-r', x1: rightX, y1: padTop - 8, x2: rightX, y2: H - 22, stroke: C.borderStrong, strokeWidth: 1.5 }))
      marks.push(h('text', { key: 'lbl-l', x: leftX - 34, y: padTop - 12, fontSize: 10, fill: C.muted }, '对话'))
      marks.push(h('text', { key: 'lbl-r', x: rightX - 6, y: padTop - 12, fontSize: 10, fill: C.muted }, '后台'))

      for (const [index, item] of timeline.entries()) {
        const y = yOf(index)
        if (item.kind === 'turn') {
          const isHot = false
          marks.push(h('circle', { key: `t-${item.turn.turn}`, cx: leftX, cy: y, r: isHot ? 4.5 : 3.5, fill: C.brand }))
          marks.push(h('text', { key: `tt-${item.turn.turn}`, x: leftX - 40, y: y + 4, fontSize: 10, fill: C.muted, textAnchor: 'end' }, `第${item.turn.turn}轮`))
          const readable = (item.turn.label ?? '').startsWith('Ciallo') ? '' : (item.turn.label ?? '').slice(0, 16)
          if (readable !== '') {
            marks.push(h('text', { key: `tl-${item.turn.turn}`, x: leftX + 10, y: y + 4, fontSize: 11, fill: C.muted }, readable))
          }
          continue
        }
        const event = item.event
        const branch = branches.find((entry) => entry.id === event.branchId)
        if (branch === undefined) continue
        const isHot = selected === branch.id || hover === branch.id
        const color = branch.status === 'merged' ? C.success : branch.status === 'abandoned' ? C.idle : C.brand
        const forkRow = eventRow(`fork:${branch.id}`)
        const mergeEventId = `merge:${branch.id}`
        const mergeRow = eventRow(mergeEventId)
        // 汇回发生在第几轮，就连到左脊的那一行；老分支没记录轮次时退回同一行。
        const mergeTurnRow = branch.mergeTurn === null ? undefined : rowOf.get(`turn:${branch.mergeTurn}`)
        const mergeY = mergeTurnRow !== undefined ? yOf(mergeTurnRow) : mergeRow === undefined ? null : yOf(mergeRow)

        // 从「对话脊」连到「后台脊」：这就是「第几轮派出去的」
        if (event.kind === 'fork' && forkRow !== undefined) {
          marks.push(h('path', {
            key: `link-${branch.id}`,
            d: `M ${leftX},${yOf(forkRow)} C ${leftX + 90},${yOf(forkRow)} ${rightX - 90},${y} ${rightX},${y}`,
            fill: 'none',
            stroke: color,
            strokeWidth: isHot ? 2 : 1.2,
            opacity: isHot ? 1 : 0.8,
          }))
        }
        // 汇回：从后台脊拐回对话脊
        if (event.kind === 'merge' || event.kind === 'abandon') {
          marks.push(h('path', {
            key: `back-${branch.id}`,
            d: `M ${rightX},${y} C ${rightX - 90},${y} ${leftX + 90},${mergeY ?? y} ${leftX},${mergeY ?? y}`,
            fill: 'none',
            stroke: color,
            strokeWidth: isHot ? 2 : 1.2,
            strokeDasharray: '4 3',
            opacity: isHot ? 1 : 0.8,
          }))
        }

        const radius = event.kind === 'merge' ? 4.5 : event.kind === 'job' ? 3.2 : 4
        marks.push(h('circle', {
          key: `e-${event.id}`,
          cx: rightX,
          cy: y,
          r: isHot ? radius + 1.5 : radius,
          fill: event.kind === 'merge' ? color : event.kind === 'job' ? C.base : C.base,
          stroke: color,
          strokeWidth: 1.8,
          style: { cursor: 'pointer' },
          onMouseEnter: () => setHover(branch.id),
          onMouseLeave: () => setHover(null),
          onClick: () => setSelected(selected === branch.id ? null : branch.id),
        }))
        const suffix =
          event.kind === 'fork'
            ? `${branch.label.slice(0, 12)}${branch.forkTurn === null ? '' : ` · 第${branch.forkTurn}轮`}`
            : event.kind === 'merge'
              ? `汇回${branch.mergedInto === null ? '' : ` ${branch.mergedInto}`}`
              : event.kind === 'job'
                ? `任务 ${event.jobId}`
                : `放弃 ${branch.id}`
        marks.push(h('text', {
          key: `et-${event.id}`,
          x: rightX + 12,
          y: y + 4,
          fontSize: 11,
          fill: isHot ? C.brand : C.text,
          style: { cursor: 'pointer' },
          onMouseEnter: () => setHover(branch.id),
          onMouseLeave: () => setHover(null),
          onClick: () => setSelected(selected === branch.id ? null : branch.id),
        }, suffix))
      }

      const hovered = hover === null ? null : branches.find((branch) => branch.id === hover)
      const chosen = selected === null ? null : branches.find((branch) => branch.id === selected)
      const hoverPos = (() => {
        if (hovered === null) return null
        const row = eventRow(`fork:${hovered.id}`)
        return { x: leftX + 40, y: Math.max(yOf(row ?? 0) - 14, 0) }
      })()

      return h(
        'div',
        { style: { display: 'flex', minHeight: 0 } },
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0, overflow: 'auto', padding: '18px 20px' } },
          h(CountsStrip, { graph }),
          h(
            'div',
            { style: { position: 'relative', width: W } },
            h('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': t('graph.title') }, ...marks),
            hovered !== null
              ? h(
                  'div',
                  {
                    style: {
                      position: 'absolute',
                      left: Math.min(hoverPos.x, W - 240),
                      top: Math.max(hoverPos.y, 0),
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
                  h('div', { style: { fontWeight: 600, marginBottom: 2 } }, `${hovered.id} ${hovered.label}`),
                  hovered.summary ? h('div', { style: { color: C.muted } }, hovered.summary) : null,
                  h('div', { style: { color: C.muted, marginTop: 4 } },
                    `${hovered.forkTurn === null ? '' : `第 ${hovered.forkTurn} 轮分叉 · `}${hovered.jobs.length} 个任务 · ${
                      hovered.status === 'merged' ? `已汇回${hovered.mergedInto ? ` ${hovered.mergedInto}` : ''}` : hovered.status === 'abandoned' ? '已放弃' : '进行中'
                    }`),
                )
              : null,
          ),
        ),
        chosen !== null
          ? h(
              'aside',
              {
                style: {
                  flex: '0 0 320px',
                  borderLeft: `0.5px solid ${C.border}`,
                  padding: '18px 18px 24px',
                  overflow: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  background: C.layer1,
                  color: C.text,
                },
              },
              h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
                h('strong', { style: { fontSize: 14 } }, `${chosen.id} ${chosen.label}`),
                h('button', {
                  type: 'button',
                  onClick: () => setSelected(null),
                  'aria-label': t('graph.close'),
                  style: { border: 0, background: 'transparent', color: C.muted, cursor: 'pointer', fontSize: 13 },
                }, '×'),
              ),
              chosen.summary ? h('div', { style: { fontSize: 12, color: C.muted, lineHeight: '18px' } }, chosen.summary) : null,
              chosen.premise ? h('div', { style: { fontSize: 12, lineHeight: '18px' } }, h('span', { style: { color: C.muted } }, `${t('graph.premise')}：`), chosen.premise) : null,
              chosen.quotes?.length
                ? h('div', { style: { fontSize: 12, lineHeight: '18px' } },
                    h('div', { style: { color: C.muted, marginBottom: 2 } }, t('graph.quotes')),
                    ...chosen.quotes.map((quote, index) => h('div', { key: index, style: { borderLeft: `2px solid ${C.border}`, paddingLeft: 8, marginBottom: 2 } }, quote)),
                  )
                : null,
              chosen.facts?.length
                ? h('div', { style: { fontSize: 12, lineHeight: '18px' } },
                    h('div', { style: { color: C.muted, marginBottom: 2 } }, t('graph.facts')),
                    h('div', null, chosen.facts.join('、')),
                  )
                : null,
              h('div', { style: { fontSize: 12, color: C.muted } }, t('graph.jobs')),
              ...(chosen.jobs.length === 0
                ? [h('div', { key: 'nojob', style: { fontSize: 12, color: C.muted } }, t('graph.noJobs'))]
                : chosen.jobs.map((job) =>
                    h('div', { key: job.id, style: { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12 } },
                      h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${job.id} ${job.label}`),
                      h('span', { style: { color: C.muted, flex: 'none' } }, job.state),
                    ),
                  )),
              chosen.mergeClaim
                ? h('div', { style: { fontSize: 12, lineHeight: '18px' } },
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
    function MiOpIIkView(props) {
      const { sessionId, useProjection } = props ?? {}
      const snapshot = typeof useProjection === 'function' ? useProjection('miopiikBackstage') : undefined
      const [tab, setTab] = React.useState('graph')
      const tabs = [
        ['graph', t('tab.graph')],
        ['loops', t('tab.loops')],
        ['facts', t('tab.facts')],
        ['running', t('tab.running')],
        ['drafts', t('tab.drafts')],
        ['letter', t('tab.letter')],
        ['audit', t('tab.audit')],
      ]
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: C.base, color: C.text } },
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
        ),
        h(
          'div',
          { style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: tab === 'graph' ? 0 : '18px 22px' } },
          tab === 'graph'
            ? h(FishboneView, props)
            : tab === 'loops'
              ? h(LoopsPane, { snapshot, sessionId })
              : tab === 'facts'
                ? h(FactsPane, { snapshot, sessionId })
                : tab === 'running'
                  ? h(RunningPane, { snapshot })
                  : tab === 'drafts'
                    ? h(DraftsPane, { snapshot })
                    : tab === 'letter'
                      ? h(LetterPane, { snapshot })
                      : h(AuditPane, { snapshot }),
        ),
      )
    }

    function LoopsPane({ snapshot, sessionId }) {
      const loops = snapshot?.loops
      if (loops === undefined) return h('div', { style: styles.empty }, t('loops.offline'))
      const active = loops.active ?? []
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: styles.meta }, t('loops.subtitle')),
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

    function FactsPane({ snapshot, sessionId }) {
      const facts = snapshot?.facts
      if (facts === undefined) return h('div', { style: styles.empty }, t('facts.offline'))
      const items = facts.items ?? []
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: styles.meta }, t('facts.subtitle')),
        items.length === 0
          ? h('div', { style: styles.empty }, t('facts.empty'))
          : items.map((fact) =>
              h(
                'div',
                { key: fact.id, style: styles.row },
                h(
                  'div',
                  { style: styles.rowText },
                  fact.claim,
                  h('div', { style: styles.meta }, `${fact.id} · ${fact.conf} · ${fact.source}`),
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
              ),
            ),
      )
    }

    function RunningPane({ snapshot }) {
      const jobs = snapshot?.jobs
      if (jobs === undefined) return h('div', { style: styles.empty }, t('running.offline'))
      const items = jobs.items ?? []
      const branches = snapshot?.branches?.items ?? []
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: styles.meta }, t('running.subtitle')),
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

    function DraftsPane({ snapshot }) {
      const drafts = snapshot?.drafts?.items ?? []
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: styles.meta }, t('drafts.subtitle')),
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

    function LetterPane({ snapshot }) {
      const letter = snapshot?.letter ?? null
      if (letter === null) {
        return h('div', { style: styles.empty }, t('letter.empty'))
      }
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { style: styles.meta }, t('letter.subtitle')),
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


    // 可调项（与 host/config-defaults.js 的 DEFAULTS 保持一致；test/settings.test.js 会校验漂移）
    const KNOBS = [
      ['stateRoot', '账本目录（相对工作区）', '.dsh/miopiik'],
      ['activeLoopCap', '活跃开环上限', 12],
      ['dormantAfterDays', '几天没被碰到就休眠', 2],
      ['foldedAfterDays', '几天后折成一行', 7],
      ['draftExpireDays', '草稿几天没人碰自动丢弃', 7],
      ['briefingMaxChars', '简报字数上限', 1800],
      ['inboxMaxPreviews', '每轮最多几条完整预览', 3],
      ['detailInlineMaxChars', '多长的详情转成指针', 1200],
      ['operatorTimeoutMs', 'Operator 超时（毫秒）', 1200000],
      ['operatorStallMs', '多久没新观测算卡住（毫秒）', 360000],
      ['inkModel', 'Ink 编译模型（空=跟随会话）', null],
    ]

    function SettingsSection() {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 2px', color: C.text } },
        h(
          'div',
          { style: { fontSize: 13, lineHeight: '20px', color: C.muted } },
          h('div', null, t('settings.intro')),
          h('div', { style: { marginTop: 6 } }, t('settings.where')),
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 0, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' } },
          ...KNOBS.map(([key, label, value], index) =>
            h(
              'div',
              {
                key,
                style: {
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '9px 12px',
                  borderTop: index === 0 ? 'none' : `1px solid ${C.border}`,
                  fontSize: 12,
                },
              },
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
                h('span', null, label),
                h('span', { style: { fontSize: 11, color: C.muted } }, key),
              ),
              h(
                'span',
                { style: { flex: 'none', color: C.muted, fontVariantNumeric: 'tabular-nums' } },
                value === null ? t('settings.followSession') : String(value),
              ),
            ),
          ),
        ),
        h('div', { style: { fontSize: 11, color: C.muted, lineHeight: '17px' } }, t('settings.hotReload')),
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
      'facts.subtitle': '已确认的结论。标记失效比重新解释更省事。',
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
      'settings.title': 'MiOpIIk',
      'settings.intro': '后台参数配置。默认值通常无需修改；调整前请确认要改变的具体判断。',
      'settings.where': '修改方式：编辑 profile 的 cordis.patch.yml，在 miopiik-dsh 的 config 段写入覆盖字段，保存后热重载生效。',
      'settings.followSession': '跟随会话默认',
      'settings.hotReload': '本页只读：以配置文件为唯一来源，避免界面与文件产生两份不一致的配置。',
    }

    const en = {
      'tab.graph': 'Fishbone',
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
      'facts.subtitle': 'Conclusions we confirmed. Invalidating one beats explaining again.',
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
      'settings.title': 'MiOpIIk',
      'settings.intro': 'Backstage parameters. Defaults usually need no change; confirm the judgement you intend to alter first.',
      'settings.where': 'To change: edit cordis.patch.yml in your profile, add the field under the miopiik-dsh config block, then save — hot reload applies it.',
      'settings.followSession': 'follow session',
      'settings.hotReload': 'Read-only on purpose: the config file stays the single source, so the UI cannot disagree with it.',
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands'],
      apply(ctx) {
        clientCtx = ctx
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'miopiik: dictionaries')
        t = ctx.locale.bind(NS)

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'miopiik',
              order: 60,
              locale: NS,
              label: () => t('settings.title'),
            },
            SettingsSection,
          ),
        )

        // 唯一入口：会话视图里的一个功能页（与「对话 / 轨迹」并列），图与各面板都在这一页里。
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            { name: 'conversation.view', id: 'miopiik', order: 20, locale: NS, label: () => t('view.miopiik') },
            MiOpIIkView,
          ),
        )
      },
    }
  },
})
