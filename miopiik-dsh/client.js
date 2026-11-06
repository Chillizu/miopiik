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
      const { sessionId, useProjection, onOpenStream, focusBranch } = props ?? {}
      const snapshot = typeof useProjection === 'function' ? useProjection('miopiikBackstage') : undefined
      const graph = snapshot?.graph
      const [hover, setHover] = React.useState(null)
      const [selected, setSelected] = React.useState(null)
      React.useEffect(() => {
        if (typeof focusBranch === 'string' && focusBranch !== '') setSelected(focusBranch)
      }, [focusBranch])
      // 画布宽度跟着容器走：大屏铺满，小屏不留白。
      const wrapRef = React.useRef(null)
      const [avail, setAvail] = React.useState(0)
      React.useEffect(() => {
        const el = wrapRef.current
        if (el === null || typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver((entries) => {
          const width = entries[0]?.contentRect?.width ?? 0
          if (width > 0) setAvail(width)
        })
        observer.observe(el)
        return () => observer.disconnect()
      }, [])
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
      // 宽屏别把两条脊拉太远：上限 780，居中。
      const W = Math.min(780, Math.max(560, Math.round((avail || 620) - 48)))
      const rightX = Math.max(360, W - 210)

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
      // 两条脊：都用主色，粗细表达「这是主干」；其余元素一律降调。
      marks.push(h('line', { key: 'spine-l', x1: leftX, y1: padTop - 8, x2: leftX, y2: H - 22, stroke: C.brand, strokeWidth: 2.5, strokeLinecap: 'round' }))
      marks.push(h('line', { key: 'spine-r', x1: rightX, y1: padTop - 8, x2: rightX, y2: H - 22, stroke: C.brand, strokeWidth: 2.5, strokeLinecap: 'round' }))
      marks.push(h('text', { key: 'lbl-l', x: leftX - 40, y: padTop - 12, fontSize: 10, fill: C.muted }, '对话'))
      marks.push(h('text', { key: 'lbl-r', x: rightX + 8, y: padTop - 12, fontSize: 10, fill: C.muted }, '后台'))
      // 方向：时间向下。两条脊各带一个向下箭头，比文字解释直观。
      const arrow = (x, key) =>
        h('path', {
          key,
          d: `M ${x - 4},${H - 26} L ${x},${H - 18} L ${x + 4},${H - 26}`,
          fill: 'none',
          stroke: C.brand,
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        })
      marks.push(arrow(leftX, 'arr-l'))
      marks.push(arrow(rightX, 'arr-r'))
      marks.push(h('text', { key: 'time', x: (leftX + rightX) / 2, y: padTop - 12, fontSize: 10, fill: C.muted, textAnchor: 'middle' }, '时间 ↓'))

      const stateColor = (state) => {
        if (state === 'running') return C.brand
        if (state === 'done') return C.success
        if (state === 'failed' || state === 'stalled' || state === 'timeout') return C.error
        return C.muted
      }

      for (const [index, item] of timeline.entries()) {
        const y = yOf(index)
        if (item.kind === 'turn') {
          marks.push(h('circle', { key: `t-${item.turn.turn}`, cx: leftX, cy: y, r: 4, fill: C.brand }))
          marks.push(h('text', { key: `tt-${item.turn.turn}`, x: leftX - 12, y: y + 4, fontSize: 10, fill: C.brand, textAnchor: 'end', fontWeight: 500 }, `第${item.turn.turn}轮`))
          const readable = (item.turn.label ?? '').startsWith('Ciallo') ? '' : (item.turn.label ?? '').slice(0, 16)
          if (readable !== '') {
            marks.push(h('text', { key: `tl-${item.turn.turn}`, x: leftX + 12, y: y + 4, fontSize: 11, fill: C.muted }, readable))
          }
          continue
        }
        const event = item.event
        const branch = branches.find((entry) => entry.id === event.branchId)
        if (branch === undefined) continue
        const isHot = selected === branch.id || hover === branch.id
        const forkRow = eventRow(`fork:${branch.id}`)
        const mergeEventId = `merge:${branch.id}`
        const mergeRow = eventRow(mergeEventId)
        const mergeTurnRow = branch.mergeTurn === null ? undefined : rowOf.get(`turn:${branch.mergeTurn}`)
        const mergeY = mergeTurnRow !== undefined ? yOf(mergeTurnRow) : mergeRow === undefined ? null : yOf(mergeRow)

        // 通信线：从对话脊出发（实线），回到对话脊（虚线）。用中性色，主色只留给脊。
        if (event.kind === 'fork' && forkRow !== undefined) {
          // 派出：箭头落在右脊上
          marks.push(h('path', {
            key: `arr-out-${branch.id}`,
            d: `M ${rightX - 10},${y - 4.5} L ${rightX - 1},${y} L ${rightX - 10},${y + 4.5} Z`,
            fill: isHot ? C.text : C.link,
            opacity: isHot ? 0.95 : 0.7,
          }))
          marks.push(h('path', {
            key: `link-${branch.id}`,
            d: `M ${leftX},${yOf(forkRow)} C ${leftX + 90},${yOf(forkRow)} ${rightX - 90},${y} ${rightX},${y}`,
            fill: 'none',
            stroke: isHot ? C.text : C.link,
            strokeWidth: isHot ? 2 : 1,
            opacity: isHot ? 0.95 : 0.55,
          }))
        }
        if (event.kind === 'merge' || event.kind === 'abandon') {
          // 收回：箭头落在左脊上
          marks.push(h('path', {
            key: `arr-in-${branch.id}`,
            d: `M ${leftX + 10},${(mergeY ?? y) - 4.5} L ${leftX + 1},${mergeY ?? y} L ${leftX + 10},${(mergeY ?? y) + 4.5} Z`,
            fill: isHot ? C.text : C.link,
            opacity: isHot ? 0.95 : 0.7,
          }))
          marks.push(h('path', {
            key: `back-${branch.id}`,
            d: `M ${rightX},${y} C ${rightX - 90},${y} ${leftX + 90},${mergeY ?? y} ${leftX},${mergeY ?? y}`,
            fill: 'none',
            stroke: isHot ? C.text : C.link,
            strokeWidth: isHot ? 2 : 1,
            strokeDasharray: '4 4',
            opacity: isHot ? 0.95 : 0.5,
          }))
        }

        const color = event.kind === 'job' ? stateColor(event.state) : branch.status === 'abandoned' ? C.idle : C.brand
        const hot = isHot ? 1.5 : 0

        // Ink 侧事件 = 圆；执行层（Operator）= 方。形状=层，颜色=状态。
        if (event.kind === 'job') {
          const size = 10 + hot * 2
          marks.push(h('rect', {
            key: `e-${event.id}`,
            x: rightX - size / 2,
            y: y - size / 2,
            width: size,
            height: size,
            rx: 2,
            fill: event.state === 'running' ? color : event.state === 'done' ? color : C.base,
            fillOpacity: event.state === 'running' ? 1 : event.state === 'done' ? 0.35 : 1,
            stroke: color,
            strokeWidth: 2,
            style: { cursor: 'pointer' },
            onMouseEnter: () => setHover(branch.id),
            onMouseLeave: () => setHover(null),
            onClick: () => setSelected(selected === branch.id ? null : branch.id),
          }))
        } else {
          marks.push(h('circle', {
            key: `e-${event.id}`,
            cx: rightX,
            cy: y,
            r: (event.kind === 'merge' ? 4.5 : 4) + hot,
            fill: event.kind === 'merge' ? color : C.base,
            stroke: color,
            strokeWidth: 1.8,
            style: { cursor: 'pointer' },
            onMouseEnter: () => setHover(branch.id),
            onMouseLeave: () => setHover(null),
            onClick: () => setSelected(selected === branch.id ? null : branch.id),
          }))
        }

        const suffix =
          event.kind === 'fork'
            ? `${branch.label.slice(0, 12)}${branch.forkTurn === null ? '' : ` · 第${branch.forkTurn}轮`}`
            : event.kind === 'merge'
              ? `汇回${branch.mergedInto === null ? '' : ` ${branch.mergedInto}`}`
              : event.kind === 'job'
                ? `${event.jobId} ${event.state ?? ''}${event.label ? ` · ${String(event.label).slice(0, 10)}` : ''}`
                : `放弃 ${branch.id}`
        marks.push(h('text', {
          key: `et-${event.id}`,
          x: rightX + 12,
          y: y + 4,
          fontSize: 11,
          fill: isHot ? C.text : event.kind === 'job' ? stateColor(event.state) : C.text,
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
              ref: wrapRef,
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
                    h(
                      'div',
                      { style: { color: C.muted, marginTop: 4 } },
                      `${hovered.forkTurn === null ? '' : `第 ${hovered.forkTurn} 轮分叉 · `}${hovered.jobs.length} 个任务 · ${
                        hovered.status === 'merged'
                          ? `已汇回${hovered.mergedInto ? ` ${hovered.mergedInto}` : ''}`
                          : hovered.status === 'abandoned'
                            ? '已放弃'
                            : '进行中'
                      }`,
                    ),
                  )
                : null,
            ),
          ),
        ),
        chosen !== null
          ? h(
              'aside',
              {
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
                : chosen.jobs.map((job) =>
                    h(
                      'div',
                      { key: job.id, style: { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12 } },
                      h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${job.id} ${job.label}`),
                      h('span', { style: { color: C.muted, flex: 'none' } }, job.state),
                    ),
                  )),
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
      const [streamFilter, setStreamFilter] = React.useState(null) // {branch} | null
      const [focusBranch, setFocusBranch] = React.useState(null)
      const openStream = (branchId) => {
        setStreamFilter({ branch: branchId })
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
                  h('div', { style: { flex: '1 1 auto', minWidth: 0, minHeight: 0 } }, h(FishboneView, { ...props, onOpenStream: openStream, focusBranch })),
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
              : h(FishboneView, { ...props, onOpenStream: openStream, focusBranch })
            : tab === 'list'
              ? h(ListPane, { snapshot, sessionId })
              : h(StreamPane, {
                  snapshot,
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
     * 流水：一行一条（决定或任务），点开右侧看完整内容。
     * 不设全局「完整模式」——详情是按需的，不是一次性倒出来。
     */
    function StreamPane({ snapshot, filter = null, onClearFilter, onOpenGraph }) {
      const audit = snapshot?.audit
      const [kind, setKind] = React.useState('all')
      const [query, setQuery] = React.useState('')
      const [open, setOpen] = React.useState(null)
      if (audit === undefined) return h('div', { style: styles.empty }, t('stream.offline'))

      const notes = (audit.notes ?? []).map((note) => ({ ...note, rowKind: note.kind === 'preview' || note.kind === 'answer' ? 'note' : note.kind }))
      const factRows = (audit.factEvents ?? []).map((fact) => ({
        id: fact.id,
        rowKind: 'fact',
        kindLabel: 'fact',
        claim: `${fact.stale ? '（已失效）' : ''}${fact.claim}`,
        at: fact.at,
        branch: null,
        fact,
      }))
      const branchRows = (audit.branchEvents ?? []).map((branch) => ({
        id: `ev-${branch.id}`,
        rowKind: 'branch',
        kindLabel: 'branch',
        claim: `${branch.id} ${branch.label} · ${branch.status}`,
        at: branch.at,
        branch: branch.id,
      }))
      const jobs = (audit.jobs ?? []).map((job) => ({
        id: job.id,
        rowKind: 'job',
        kindLabel: 'job',
        claim: `${job.id} ${job.state} — ${job.label}`,
        at: job.startedAt ?? 0,
        branch: job.branchId,
        job,
      }))
      const obs = audit.observations ?? {}
      const rows = [...notes, ...factRows, ...branchRows, ...jobs].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))

      const counts = rows.reduce((acc, row) => {
        acc[row.kindLabel ?? row.kind] = (acc[row.kindLabel ?? row.kind] ?? 0) + 1
        return acc
      }, {})
      const kinds = ['all', ...Object.keys(counts)]
      const needle = query.trim().toLowerCase()
      const shown = rows
        .filter((row) => (filter?.branch ? row.branch === filter.branch : true))
        .filter((row) => (kind === 'all' ? true : (row.kindLabel ?? row.kind) === kind))
        .filter((row) => (needle === '' ? true : `${row.claim} ${row.branch ?? ''} ${row.why ?? ''}`.toLowerCase().includes(needle)))

      const chosen = open === null ? null : rows.find((row) => row.id === open) ?? null

      return h(
        'div',
        { style: { display: 'flex', gap: 16, alignItems: 'flex-start' } },
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            filter?.branch
              ? h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => (typeof onClearFilter === 'function' ? onClearFilter() : undefined),
                    style: { padding: '3px 9px', border: `0.5px solid ${C.brand}`, borderRadius: 12, background: C.brand, color: '#fff', cursor: 'pointer', fontSize: 11 },
                  },
                  `${filter.branch} ×`,
                )
              : null,
            ...kinds.map((entry) =>
              h(
                'button',
                {
                  key: entry,
                  type: 'button',
                  onClick: () => setKind(entry),
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
                `${entry === 'all' ? t('stream.all') : entry}${entry === 'all' ? ` ${rows.length}` : ` ${counts[entry]}`}`,
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
            { style: { display: 'flex', gap: 18, fontSize: 11, color: C.muted } },
            h('span', null, `${t('stream.observed')} ${obs.user ?? 0} / ${obs.assistant ?? 0} / ${obs.tool ?? 0}`),
            h('span', null, `${t('stream.decisions')} ${rows.length}`),
          ),
          shown.length === 0
            ? h('div', { style: styles.empty }, t('stream.empty'))
            : shown.map((row) =>
                h(
                  'div',
                  {
                    key: row.id,
                    onClick: () => setOpen(open === row.id ? null : row.id),
                    style: {
                      display: 'flex',
                      gap: 10,
                      alignItems: 'baseline',
                      padding: '6px 4px',
                      margin: '0 -4px',
                      borderRadius: 6,
                      borderBottom: `0.5px solid ${C.border}`,
                      cursor: 'pointer',
                      background: open === row.id ? C.layer1 : 'transparent',
                    },
                  },
                  h('span', { style: { flex: 'none', width: 62, fontSize: 11, color: C.muted, fontVariantNumeric: 'tabular-nums' } },
                    row.at ? new Date(row.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''),
                  h('span', { style: { flex: 'none', width: 62, fontSize: 11, color: row.rowKind === 'job' ? C.warn : C.brand } }, row.kindLabel ?? row.kind),
                  h('span', { style: { flex: '1 1 auto', minWidth: 0, fontSize: 12, color: C.text } }, row.claim),
                  row.branch ? h('span', { style: { flex: 'none', fontSize: 11, color: C.muted } }, row.branch) : null,
                ),
              ),
        ),
        chosen === null ? null : h(StreamDetail, { row: chosen, onClose: () => setOpen(null), onOpenGraph }),
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


    // 可调项（与 host/config-defaults.js 的 DEFAULTS 保持一致；test/settings.test.js 会校验漂移）
    const KNOBS = [
      ['stateRoot', '账本目录（相对工作区）', '.dsh/miopiik'],
      ['activeLoopCap', '活跃开环上限', 12],
      ['dormantAfterDays', '几天没被碰到就休眠', 2],
      ['foldedAfterDays', '几天后折成一行', 7],
      ['draftExpireDays', '草稿几天没人碰自动丢弃', 7],
      ['briefingMaxChars', '简报字数上限', 1800],
      ['inboxPreviewChars', '每轮预览总字数上限', 220],
      ['detailInlineMaxChars', '多长的详情转成指针', 1200],
      ['inkTailLimit', '中间层上下文尾部条数', 24],
      ['inkHeadMaxChars', '中间层头部上限（字）', 2000],
      ['operatorTimeoutMs', 'Operator 超时（毫秒）', 1200000],
      ['operatorStallMs', '多久没新观测算卡住（毫秒）', 360000],
      ['inkModel', 'Ink 编译模型（空=跟随会话）', null],
      ['conversationCompile', '对话编译（回合后产候选）', true],
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
      'tab.list': '清单',
      'tab.stream': '流水',
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
      'stream.empty': '后台还没有做过任何决定。',
      'stream.all': '全部',
      'stream.search': '搜结论或分支',
      'stream.observed': '观测（用户/回复/工具）',
      'stream.decisions': '决定',
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
      'settings.title': 'MiOpIIk',
      'settings.intro': '后台参数配置。默认值通常无需修改；调整前请确认要改变的具体判断。',
      'settings.where': '修改方式：编辑 profile 的 cordis.patch.yml，在 miopiik-dsh 的 config 段写入覆盖字段，保存后热重载生效。',
      'settings.followSession': '跟随会话默认',
      'settings.hotReload': '本页只读：以配置文件为唯一来源，避免界面与文件产生两份不一致的配置。',
    }

    const en = {
      'tab.graph': 'Fishbone',
      'tab.list': 'List',
      'tab.stream': 'Stream',
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
      'stream.empty': 'The backstage has not made any decision yet.',
      'stream.all': 'All',
      'stream.search': 'Search claim or branch',
      'stream.observed': 'Observed (user/reply/tool)',
      'stream.decisions': 'Decisions',
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
