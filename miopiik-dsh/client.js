/**
 * miopiik-dsh — Client 半边（Web）。
 *
 * SPEC §6：不做导航栏，次级视图从对话里长出来。
 *  - conversation.composer.dock —— 存在感（一个点 +「后台」，有在跑的任务时才带数字）
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

    function TabButton({ id, label, active }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': active ? 'true' : 'false',
          onClick: () => overlay.set({ ...overlay.get(), tab: id }),
          style: {
            padding: '5px 10px',
            borderRadius: 8,
            border: `1px solid ${active ? C.borderStrong : C.border}`,
            background: 'transparent',
            color: active ? C.text : C.muted,
            cursor: 'pointer',
            fontSize: 12,
          },
        },
        label,
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
      const tab = state.tab === 'facts' ? 'facts' : state.tab === 'running' ? 'running' : 'loops'
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
            { role: 'tablist', style: { display: 'flex', gap: 8 } },
            h(TabButton, { id: 'loops', label: t('tab.loops'), active: tab === 'loops' }),
            h(TabButton, { id: 'facts', label: t('tab.facts'), active: tab === 'facts' }),
            h(TabButton, { id: 'running', label: t('tab.running'), active: tab === 'running' }),
          ),
          tab === 'loops'
            ? h(LoopsPane, { snapshot, sessionId })
            : tab === 'facts'
              ? h(FactsPane, { snapshot, sessionId })
              : h(RunningPane, { snapshot }),
          h('div', { style: { fontSize: 11, color: C.muted, lineHeight: '17px' } }, t('drawer.hint')),
        ),
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
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 6,
              width: '100%',
              padding: '2px 8px',
              background: 'transparent',
              border: 0,
              cursor: 'pointer',
              color: C.muted,
              fontSize: 11,
              lineHeight: '16px',
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
      'presence.label': '后台',
      'presence.title': '打开后台',
      'drawer.title': '后台',
      'drawer.close': '关闭',
      'drawer.hint': '这里只放你让 Mind 去看的东西；任务细节不会打断对话。',
      'tab.loops': '悬着的事',
      'tab.facts': '我们一起定的',
      'tab.running': '后台在跑',
      'loops.subtitle': '对话里还没合上的线索。划掉一条不需要解释，系统自己收拾。',
      'loops.empty': '现在没有悬着的事。',
      'loops.offline': '这个会话的后台还没连上。',
      'loops.close': '划掉',
      'loops.dormant': '休眠',
      'loops.closed': '已闭合',
      'facts.subtitle': '我们一起确认过的结论。标废一条，比重新解释一遍便宜。',
      'facts.empty': '还没有记下来的结论。',
      'facts.offline': '这个会话的后台还没连上。',
      'facts.invalidate': '标废',
      'running.subtitle': '后台在做什么；细节不会进对话。',
      'running.empty': '现在没有在跑的东西。',
      'running.offline': '这个会话的后台还没连上。',
    }

    const en = {
      'presence.label': 'Backstage',
      'presence.title': 'Open the backstage',
      'drawer.title': 'Backstage',
      'drawer.close': 'Close',
      'drawer.hint': 'Only what you asked Mind to look at lives here; task details never interrupt the conversation.',
      'tab.loops': 'Open threads',
      'tab.facts': 'What we settled',
      'tab.running': 'Running backstage',
      'loops.subtitle': 'Threads in the conversation that are not closed yet. Closing one needs no explanation; the system cleans up.',
      'loops.empty': 'Nothing is hanging right now.',
      'loops.offline': 'The backstage of this session is not connected yet.',
      'loops.close': 'Close',
      'loops.dormant': 'dormant',
      'loops.closed': 'closed',
      'facts.subtitle': 'Conclusions we confirmed together. Invalidating one beats explaining again.',
      'facts.empty': 'Nothing has been written down yet.',
      'facts.offline': 'The backstage of this session is not connected yet.',
      'facts.invalidate': 'Invalidate',
      'running.subtitle': 'What the backstage is doing; details stay out of the conversation.',
      'running.empty': 'Nothing is running right now.',
      'running.offline': 'The backstage of this session is not connected yet.',
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands'],
      apply(ctx) {
        clientCtx = ctx
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'miopiik: dictionaries')
        t = ctx.locale.bind(NS)

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'miopiik-presence', order: 40, locale: NS },
            Presence,
          ),
        )
      },
    }
  },
})
