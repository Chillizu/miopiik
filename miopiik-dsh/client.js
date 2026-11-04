/**
 * miopiik-dsh — Client 半边（Web）。
 *
 * SPEC §6：不做导航栏，次级视图从对话里长出来。
 *  - conversation.session.header.utilities —— 存在感胶囊（一个点 +「后台」，有在跑时才带数字）
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
    function FishbonePane({ snapshot }) {
      const graph = snapshot?.graph
      const trunk = graph?.trunk ?? []
      const branches = graph?.branches ?? []
      if (graph === undefined || (trunk.length === 0 && branches.length === 0)) {
        return h('div', { style: styles.empty }, t('graph.empty'))
      }

      const W = 470
      const padTop = 16
      const trunkX = 16
      const laneX = 86
      const rowGap = 30
      const index = new Map(trunk.map((node, i) => [node.turn, i]))
      const yOfTurn = (turn) => {
        const i = index.get(turn)
        return i === undefined ? null : padTop + i * rowGap
      }
      const lastTrunkY = padTop + Math.max(0, trunk.length - 1) * rowGap

      const elements = []
      // 主干：一根竖线，每轮一个点；标签只放轮次，避免跟分支抢位置。
      elements.push(h('line', { key: 'trunk', x1: trunkX, y1: padTop, x2: trunkX, y2: lastTrunkY, stroke: C.borderStrong, strokeWidth: 1.5 }))
      for (const node of trunk) {
        const y = yOfTurn(node.turn)
        elements.push(h('circle', { key: `t${node.turn}`, cx: trunkX, cy: y, r: 3.5, fill: C.brand }))
        elements.push(h('text', { key: `tl${node.turn}`, x: trunkX + 9, y: y + 4, fontSize: 11, fill: C.muted }, `第${node.turn}轮`))
      }

      // 分支：贴着它的分叉点铺开（同一轮分叉的按顺序错开一行），曲线短、读起来跟主干同步。
      const slots = new Map()
      let maxY = lastTrunkY
      let prevLaneY = -Infinity
      for (const branch of branches) {
        const forkY = yOfTurn(branch.forkTurn)
        const forkBase = forkY === null ? lastTrunkY + 30 : forkY
        const slot = slots.get(forkBase) ?? 0
        slots.set(forkBase, slot + 1)
        const y = Math.max(forkBase + 24 + slot * 30, prevLaneY + 30)
        prevLaneY = y
        maxY = Math.max(maxY, y)

        const done = branch.status === 'merged'
        const color = done ? C.success : branch.status === 'abandoned' ? C.idle : C.brand
        const endX = W - 10
        // 老分支没有记录汇回轮次：退而画到主干末端，至少方向可读。
        const mergeY = branch.mergeTurn === null ? (done ? lastTrunkY : null) : yOfTurn(branch.mergeTurn)

        if (forkY !== null) {
          elements.push(
            h('path', {
              key: `f${branch.id}`,
              d: `M ${trunkX},${forkY} C ${trunkX + 24},${forkY} ${laneX - 22},${y} ${laneX},${y}`,
              fill: 'none',
              stroke: color,
              strokeWidth: 1.5,
            }),
          )
        }
        elements.push(h('line', { key: `l${branch.id}`, x1: laneX, y1: y, x2: endX, y2: y, stroke: color, strokeWidth: 1.5 }))

        if (mergeY !== null) {
          elements.push(
            h('path', {
              key: `m${branch.id}`,
              d: `M ${endX},${y} C ${endX},${y + 12} ${trunkX + 30},${mergeY} ${trunkX},${mergeY}`,
              fill: 'none',
              stroke: color,
              strokeWidth: 1.5,
              strokeDasharray: '3 3',
            }),
          )
          elements.push(h('circle', { key: `md${branch.id}`, cx: trunkX, cy: mergeY, r: 4.5, fill: C.overlay, stroke: color, strokeWidth: 1.5 }))
        }

        // 任务点直接落在分支线上；状态用实心/空心区分，标签在 title 里，不挤版面。
        const jobs = branch.jobs ?? []
        jobs.forEach((job, jobIndex) => {
          const jx = laneX + 96 + jobIndex * 22
          const running = job.state === 'running'
          elements.push(h('circle', {
            key: `${branch.id}-${job.id}`,
            cx: jx,
            cy: y,
            r: 4.5,
            fill: running ? C.brand : C.overlay,
            stroke: running ? C.brand : C.borderStrong,
            strokeWidth: 1.5,
          }))
          elements.push(h('title', { key: `${branch.id}-${job.id}-t` }, `${job.id} ${job.label}（${job.state}）`))
        })

        const statusText = done
          ? `已汇回${branch.mergedInto === null ? '' : ` ${branch.mergedInto}`}`
          : branch.status === 'abandoned'
            ? '已放弃'
            : '进行中'
        elements.push(h('text', { key: `bl${branch.id}`, x: laneX + 2, y: y - 7, fontSize: 11, fill: C.text }, branch.label.slice(0, 14)))
        elements.push(
          h('text', { key: `bm${branch.id}`, x: laneX + 2, y: y + 15, fontSize: 10, fill: C.muted }, `${branch.id} · ${jobs.length} 任务 · ${statusText}`),
        )
      }

      const H = maxY + 32
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h(CountsStrip, { graph }),
        h(
          'div',
          { style: { overflowX: 'auto' } },
          h('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': t('graph.title') }, ...elements),
        ),
        h('div', { style: { fontSize: 11, color: C.muted, lineHeight: '17px' } }, t('graph.legend')),
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

    function Drawer({ snapshot, sessionId }) {
      const state = useStore(overlay)
      React.useEffect(() => {
        if (!state.open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') overlay.set({ ...overlay.get(), open: false })
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [state.open])
      if (!state.open) return null
      const close = () => overlay.set({ ...overlay.get(), open: false })
      const known = ['graph', 'loops', 'facts', 'running', 'drafts', 'letter', 'audit']
      const tab = known.includes(state.tab) ? state.tab : 'loops'
      return h(
        'div',
        {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('drawer.title'),
          onClick: close,
          style: { position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0, 0, 0, 0.32)' },
        },
        h(
          'div',
          {
            onClick: (event) => event.stopPropagation(),
            style: {
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              width: 'min(440px, 94vw)',
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
              padding: '18px 18px 24px',
              overflowY: 'auto',
              background: C.overlay,
              borderLeft: `1px solid ${C.border}`,
              boxShadow: '-18px 0 40px rgba(0, 0, 0, 0.18)',
              color: C.text,
              fontSize: 13,
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
            h('strong', { style: { fontSize: 14 } }, t('drawer.title')),
            h(
              'button',
              {
                type: 'button',
                onClick: close,
                'aria-label': t('drawer.close'),
                style: {
                  border: `1px solid ${C.border}`,
                  background: 'transparent',
                  color: C.muted,
                  borderRadius: 8,
                  width: 28,
                  height: 28,
                  cursor: 'pointer',
                  fontSize: 14,
                  lineHeight: '24px',
                },
              },
              '\u00d7',
            ),
          ),
          h(
            'div',
            { role: 'tablist', style: { display: 'flex', gap: 16, flexWrap: 'wrap', borderBottom: `0.5px solid ${C.border}`, paddingBottom: 0, marginBottom: 2 } },
            h(TabButton, { id: 'graph', label: t('tab.graph'), active: tab === 'graph' }),
            h(TabButton, { id: 'loops', label: t('tab.loops'), active: tab === 'loops' }),
            h(TabButton, { id: 'facts', label: t('tab.facts'), active: tab === 'facts' }),
            h(TabButton, { id: 'running', label: t('tab.running'), active: tab === 'running' }),
            h(TabButton, { id: 'drafts', label: t('tab.drafts'), active: tab === 'drafts' }),
            h(TabButton, { id: 'letter', label: t('tab.letter'), active: tab === 'letter' }),
          ),
          tab === 'graph'
            ? h(FishbonePane, { snapshot })
            : tab === 'loops'
            ? h(LoopsPane, { snapshot, sessionId })
            : tab === 'facts'
              ? h(FactsPane, { snapshot, sessionId })
              : tab === 'drafts'
                ? h(DraftsPane, { snapshot })
                : tab === 'letter'
                  ? h(LetterPane, { snapshot })
                  : tab === 'audit'
                    ? h(AuditPane, { snapshot })
                    : h(RunningPane, { snapshot }),
          h(
            'button',
            {
              type: 'button',
              onClick: () => overlay.set({ ...overlay.get(), tab: tab === 'audit' ? 'loops' : 'audit' }),
              style: {
                alignSelf: 'flex-start',
                border: 0,
                background: 'transparent',
                color: C.muted,
                fontSize: 11,
                cursor: 'pointer',
                padding: 0,
                opacity: 0.7,
              },
            },
            tab === 'audit' ? t('audit.back') : t('audit.entry'),
          ),
          h('div', { style: { fontSize: 11, color: C.muted, lineHeight: '17px' } }, t('drawer.hint')),
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

    function Presence(props) {
      const { sessionId, useProjection } = props ?? {}
      const state = useStore(overlay)
      const snapshot = typeof useProjection === 'function' ? useProjection('miopiikBackstage') : undefined
      const running = snapshot?.jobs?.running ?? 0
      return h(
        'div',
        null,
        h(
          'button',
          {
            type: 'button',
            title: t('presence.title'),
            'aria-expanded': state.open ? 'true' : 'false',
            onClick: () => overlay.set({ ...overlay.get(), open: !overlay.get().open }),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 26,
              padding: '0 9px',
              background: 'transparent',
              border: `1px solid ${C.border}`,
              borderRadius: 13,
              cursor: 'pointer',
              color: running > 0 ? C.text : C.muted,
              fontSize: 12,
              lineHeight: '18px',
              whiteSpace: 'nowrap',
            },
          },
          h('span', {
            style: {
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: running > 0 ? C.success : C.idle,
              flex: 'none',
            },
          }),
          h('span', null, running > 0 ? `${t('presence.label')} · ${running}` : t('presence.label')),
        ),
        h(Drawer, { snapshot, sessionId }),
      )
    }

    const zh = {
      'presence.label': '后台任务',
      'presence.title': '打开后台面板',
      'drawer.title': '后台',
      'drawer.close': '关闭',
      'drawer.hint': '面板仅汇总后台整理的信息；任务执行细节不会进入对话。',
      'tab.graph': '鱼骨图',
      'tab.loops': '未结事项',
      'tab.facts': '已定结论',
      'tab.running': '运行中',
      'tab.drafts': '草稿',
      'tab.letter': '交接记录',
      'graph.title': '鱼骨图',
      'graph.empty': '还没有可画的东西：先聊几轮，或者让它在后台做点什么。',
      'graph.legend': '读法同 git graph：竖线是对话主干，每轮一个点；横线是分支；实线分叉、虚线汇回。点开「未结事项」可关闭其中一条。',
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
      'presence.label': 'Backstage',
      'presence.title': 'Open the backstage panel',
      'drawer.title': 'Backstage',
      'drawer.close': 'Close',
      'drawer.hint': 'This panel only summarizes what the backstage prepared; execution details never enter the conversation.',
      'tab.graph': 'Graph',
      'tab.loops': 'Open items',
      'tab.facts': 'Settled facts',
      'tab.running': 'Running',
      'tab.drafts': 'Drafts',
      'tab.letter': 'Handoff record',
      'graph.title': 'Fishbone graph',
      'graph.empty': 'Nothing to draw yet: talk a few turns, or let it do something in the background.',
      'graph.legend': 'Same reading as a git graph: the vertical line is the conversation trunk with one dot per turn; horizontals are branches; solid forking, dashed merging.',
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

        // 会话级顶栏工具位：和「计划任务」同级，属于这个会话的状态，不是全局导航。
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'miopiik-backstage', order: 0, locale: NS },
            Presence,
          ),
        )
      },
    }
  },
})
