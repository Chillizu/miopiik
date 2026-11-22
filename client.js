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
        console.warn('[mio-dbg] before execute:', line)
        const outcome = await commands.execute(sessionId, line, [])
        console.warn('[mio-dbg] after execute ok=', outcome && outcome.ok)
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
     * 跨泳道细线 = 两条分支共享同一张事实卡：悬停看事实号，点击去流水溯源。
     * 形状语言不变：圆 = Ink/Mind 侧事件，方 = Operator 任务，颜色 = 状态。
     */
    function FishboneView(props) {
      const { sessionId, useProjection, onOpenStream, onOpenFact, onOpenJob, focusBranch } = props ?? {}
      const snapshot = typeof useProjection === 'function' ? useProjection('miopiikBackstage') : undefined
      const graph = snapshot?.graph
      const [hover, setHover] = React.useState(null)
      const [selected, setSelected] = React.useState(null)
      React.useEffect(() => {
        if (typeof focusBranch === 'string' && focusBranch !== '') setSelected(focusBranch)
      }, [focusBranch])
      const branches = graph?.branches ?? []
      const events = graph?.events ?? []

      if (graph === undefined || branches.length === 0) {
        return h('div', { style: { padding: 32, color: C.muted, fontSize: 13 } }, t('graph.empty'))
      }

      // 泳道布局：左脊（对话轮次）+ 每分支一条泳道，时间一律向下。
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

      const padTop = 44
      const rowGap = 30
      const leftX = 96
      const laneW = 140
      const laneBase = leftX + 150
      const W = Math.max(560, laneBase + branches.length * laneW + 16)

      const timeline = [
        ...turns.map((turn) => ({ kind: 'turn', at: turn.at ?? 0, turn })),
        ...events.map((event) => ({ kind: 'event', at: event.at ?? 0, event })),
      ].sort((a, b) => a.at - b.at)
      const rowOf = new Map()
      timeline.forEach((item, index) => {
        rowOf.set(item.kind === 'turn' ? `turn:${item.turn.turn}` : `event:${item.event.id}`, index)
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
      // 头部一行：主干截断标记（如「最近 16/58 轮」）+ 泳道标题。
      marks.push(h('text', { key: 'turn-window', x: 8, y: 18, fontSize: 11, fill: C.muted }, windowLabel))
      marks.push(h('text', { key: 'lbl-l', x: leftX - 40, y: 18, fontSize: 10, fill: C.muted }, t('graph.spineTurns')))
      marks.push(h('text', { key: 'time', x: leftX + 12, y: 18, fontSize: 10, fill: C.muted }, '时间 ↓'))
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

      // 每分支一条泳道：标题、基线、fork 接出（实线）与 merge/abandon 接回（虚线）。
      for (const [index, branch] of branches.entries()) {
        const x = laneX(index)
        const top = laneTop(branch)
        const bottom = laneBottom(branch)
        const isHot = selected === branch.id
        marks.push(
          h(
            'text',
            { key: `lane-${branch.id}`, x, y: 18, fontSize: 10, textAnchor: 'middle', fill: branch.status === 'open' ? C.text : C.muted },
            `${branch.id} ${String(branch.label).slice(0, 10)}`,
          ),
        )
        marks.push(h('line', { key: `lanebase-${branch.id}`, x1: x, y1: top, x2: x, y2: bottom, stroke: isHot ? C.text : C.border, strokeWidth: isHot ? 1.5 : 1, opacity: isHot ? 0.9 : 0.7 }))
        marks.push(h('path', { key: `forkline-${branch.id}`, d: `M ${leftX},${top} C ${leftX + 60},${top} ${x - 50},${top} ${x - 6},${top}`, fill: 'none', stroke: isHot ? C.text : C.link, strokeWidth: isHot ? 1.5 : 1, opacity: isHot ? 0.9 : 0.55 }))
        marks.push(h('path', { key: `forkarr-${branch.id}`, d: `M ${x - 7},${top - 4} L ${x},${top} L ${x - 7},${top + 4} Z`, fill: isHot ? C.text : C.link, opacity: isHot ? 0.9 : 0.6 }))
        const mergeRow = eventRow(`merge:${branch.id}`)
        if (mergeRow !== undefined) {
          const my = yOf(mergeRow)
          marks.push(h('path', { key: `backline-${branch.id}`, d: `M ${x - 6},${my} C ${x - 60},${my} ${leftX + 60},${my} ${leftX + 6},${my}`, fill: 'none', stroke: isHot ? C.text : C.link, strokeWidth: isHot ? 1.5 : 1, strokeDasharray: '4 4', opacity: isHot ? 0.9 : 0.5 }))
          marks.push(h('path', { key: `backarr-${branch.id}`, d: `M ${leftX + 7},${my - 4} L ${leftX},${my} L ${leftX + 7},${my + 4} Z`, fill: isHot ? C.text : C.link, opacity: isHot ? 0.9 : 0.6 }))
        }
      }

      // 跨泳道共享事实：细虚线 + 小方块；悬停出事实号，点击去流水溯源。
      for (const [linkIndex, link] of links.entries()) {
        const [a, b] = link.between
        const xa = laneX(laneIndex.get(a))
        const xb = laneX(laneIndex.get(b))
        const y = Math.max(laneTop(branches[laneIndex.get(a)]), laneTop(branches[laneIndex.get(b)])) + 9 + linkIndex * 7
        const mid = (xa + xb) / 2
        marks.push(h('line', { key: `linkvis-${link.factId}-${linkIndex}`, x1: xa, y1: y, x2: xb, y2: y, stroke: C.link, strokeWidth: 1, strokeDasharray: '2 3', opacity: 0.8 }))
        marks.push(h('path', { key: `linkmark-${link.factId}-${linkIndex}`, d: `M ${mid - 3},${y - 3} L ${mid + 3},${y - 3} L ${mid + 3},${y + 3} L ${mid - 3},${y + 3} Z`, fill: C.link, opacity: 0.8 }))
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

      // 时间轴行：左脊放轮次圆点，事件落在自己泳道。
      for (const [index, item] of timeline.entries()) {
        const y = yOf(index)
        if (item.kind === 'turn') {
          marks.push(h('circle', { key: `t-${item.turn.turn}`, cx: leftX, cy: y, r: 4, fill: C.brand }))
          marks.push(h('text', { key: `tt-${item.turn.turn}`, x: leftX - 12, y: y + 4, fontSize: 10, fill: C.brand, textAnchor: 'end', fontWeight: 500 }, `第${item.turn.turn}轮`))
          const readable = (item.turn.label ?? '').startsWith('Ciallo') ? '' : (item.turn.label ?? '').slice(0, 14)
          if (readable !== '') marks.push(h('text', { key: `tl-${item.turn.turn}`, x: leftX + 12, y: y + 4, fontSize: 10, fill: C.muted }, readable))
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
          const size = isHot ? 13 : 11
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
              r: isHot ? 6 : 5,
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
      // 悬停气泡：链接给事实号；job 给状态与 stopReason；分支给摘要与进度。
      const bubble = (() => {
        if (hover === null) return null
        if (hover.kind === 'link') {
          return { x: Math.max(hover.x - 60, 8), y: Math.max(hover.y - 40, 26), title: `${t('graph.sharedFact')} ${hover.factId}`, lines: [t('graph.sharedFactHint')] }
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

      return h(
        'div',
        { style: { display: 'flex', minHeight: 0, height: '100%' } },
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 } },
          h(
            'div',
            { style: { flex: 'none', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '14px 20px 6px' } },
            h(CountsStrip, { graph }),
          ),
          h(
            'div',
            {
              style: {
                flex: '1 1 auto',
                minHeight: 0,
                // 视图容器的高度取决于外层，给一个视口上限才能真的滚起来
                maxHeight: 'calc(100vh - 250px)',
                overflow: 'auto',
                padding: '0 20px 28px',
              },
            },
            h(
              'div',
              { style: { position: 'relative', width: '100%', maxWidth: W, margin: '0 auto' } },
              h('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': t('graph.title'), style: { display: 'block' } }, ...marks),
              bubble === null
                ? null
                : h(
                    'div',
                    {
                      style: {
                        position: 'absolute',
                        left: Math.min(bubble.x, W - 240),
                        top: Math.max(bubble.y, 0),
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
                  h('div', { style: { flex: '1 1 auto', minWidth: 0, minHeight: 0 } }, h(FishboneView, { ...props, onOpenStream: openStream, onOpenFact: (factId) => traceId(factId), onOpenJob: (jobId) => traceId(jobId), focusBranch })),
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
              : h(FishboneView, { ...props, onOpenStream: openStream, onOpenFact: (factId) => traceId(factId), onOpenJob: (jobId) => traceId(jobId), focusBranch })
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
      const [l3Open, setL3Open] = React.useState(true)
      const [assemblyOpen, setAssemblyOpen] = React.useState(false)
      if (l3 === undefined || l3 === null) return h('div', { style: styles.empty }, t('ctx.offline'))
      const facts = l3.sections?.facts ?? []
      const loops = l3.sections?.loops ?? []
      const inbox = l3.sections?.inbox ?? []
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
                      { style: styles.meta },
                      `${fact.conf} · ${fact.source} · ${fact.scope === 'workspace' ? t('facts.scopeWorkspace') : t('facts.scopeSession')}`,
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
                      { style: styles.meta },
                      [
                        loop.type,
                        loop.closureCondition === null || loop.closureCondition === undefined ? null : `${t('graph.closure')}: ${loop.closureCondition}`,
                        loop.suggestedClose === true ? t('ctx.suggestedClose') : null,
                      ]
                        .filter(Boolean)
                        .join(' · '),
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
                  : `${entry} ${server?.rows.filter((row) => row.kind === entry).length ?? 0}`,
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
                    { style: { flex: 'none', width: 62, fontSize: 11, color: C.muted, fontVariantNumeric: 'tabular-nums' } },
                    row.at ? new Date(row.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '',
                  ),
                  h(
                    'span',
                    {
                      style: {
                        flex: 'none',
                        width: 96,
                        fontSize: 11,
                        color: row.rowKind === 'job' ? C.warn : row.rowKind === 'fact' ? C.success : row.rowKind === 'branch' ? C.brand : C.muted,
                      },
                    },
                    row.kind,
                  ),
                  h('span', { style: { flex: '1 1 auto', minWidth: 0, fontSize: 12, color: C.text } }, row.claim),
                  row.branch ? h('span', { style: { flex: 'none', fontSize: 11, color: C.muted } }, row.branch) : null,
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
      'ctx.facts': '已定结论（现值）',
      'ctx.loops': '悬着的事（活跃）',
      'ctx.inbox': '收件箱待读',
      'ctx.trace': '去流水溯源',
      'ctx.suggestedClose': 'Ink 提示：看似已解',
      'ctx.assembly': 'Ink 装配明细',
      'ctx.assemblyExpand': '展开明细',
      'ctx.assemblyCollapse': '收起明细',
      'ctx.assemblyHint': '装配 L3 的原始材料（head/tail/候选），默认折叠。',
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
      'ctx.facts': 'Settled conclusions (current)',
      'ctx.loops': 'Open items (active)',
      'ctx.inbox': 'Inbox to read',
      'ctx.trace': 'Trace in stream',
      'ctx.suggestedClose': 'Ink hint: looks resolved',
      'ctx.assembly': 'Ink assembly detail',
      'ctx.assemblyExpand': 'Expand',
      'ctx.assemblyCollapse': 'Collapse',
      'ctx.assemblyHint': 'Raw materials of the L3 assembly (head/tail/candidates); collapsed by default.',
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
      },
    }
  },
})
