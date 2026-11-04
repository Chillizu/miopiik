/**
 * miopiik-dsh — Client 半边（Web）。
 *
 * 遵守 SPEC §6：不做导航栏；次级视图都从对话里长出来（覆盖层）。
 *  - conversation.composer.dock —— 极轻的后台存在感（一个点 +「后台」，不谎称状态）
 *  - shell.overlay              —— 后台抽屉：悬着的事 / 我们一起定的（数据通道待接入，先给空态）
 *
 * 所有可见文案走 Client locale；样式只用 host 主题 token（--dsw-alias-*）。
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

    const C = {
      overlay: 'var(--dsw-alias-bg-overlay)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    // ── 存在感：不谎称状态，只给一个可点开的入口 ────────────────────────
    function Presence() {
      const state = useStore(overlay)
      return h(
        'button',
        {
          type: 'button',
          title: t('presence.title'),
          'aria-expanded': state.open ? 'true' : 'false',
          onClick: () => overlay.set({ ...state, open: !state.open }),
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
          style: { width: 6, height: 6, borderRadius: '50%', background: C.idle, flex: 'none' },
        }),
        h('span', null, t('presence.label')),
      )
    }

    // ── 后台抽屉：两个面，从对话里长出来 ─────────────────────────────────
    function DrawerTab({ id, label, active, onSelect }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': active ? 'true' : 'false',
          onClick: onSelect,
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

    function Drawer() {
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
      const tab = state.tab === 'facts' ? 'facts' : 'loops'
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
              width: 'min(420px, 92vw)',
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
            h(DrawerTab, {
              id: 'loops',
              label: t('panel.loops'),
              active: tab === 'loops',
              onSelect: () => overlay.set({ ...overlay.get(), tab: 'loops' }),
            }),
            h(DrawerTab, {
              id: 'facts',
              label: t('panel.facts'),
              active: tab === 'facts',
              onSelect: () => overlay.set({ ...overlay.get(), tab: 'facts' }),
            }),
          ),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h('strong', { style: { fontSize: 13 } }, t(`${tab}.title`)),
            h('div', { style: { fontSize: 12, color: C.muted, lineHeight: '18px' } }, t(`${tab}.subtitle`)),
          ),
          h(
            'div',
            {
              style: {
                border: `1px dashed ${C.border}`,
                borderRadius: 10,
                padding: '18px 16px',
                color: C.muted,
                lineHeight: '20px',
              },
            },
            t(`${tab}.empty`),
          ),
          h('div', { style: { fontSize: 11, color: C.muted, lineHeight: '17px' } }, t('drawer.hint')),
        ),
      )
    }

    const zh = {
      'presence.label': '后台',
      'presence.title': '打开后台',
      'drawer.title': '后台',
      'drawer.close': '关闭',
      'drawer.hint': '这里只放你让 Mind 去看的东西；任务细节不会打断对话。',
      'panel.loops': '悬着的事',
      'panel.facts': '我们一起定的',
      'loops.title': '悬着的事',
      'loops.subtitle': '对话里还没合上的线索。',
      'loops.empty': '现在没有悬着的事。',
      'facts.title': '我们一起定的',
      'facts.subtitle': '我们一起确认过的结论。改一条，比重新解释一遍便宜。',
      'facts.empty': '还没有记下来的结论。',
    }

    const en = {
      'presence.label': 'Backstage',
      'presence.title': 'Open the backstage',
      'drawer.title': 'Backstage',
      'drawer.close': 'Close',
      'drawer.hint': 'Only what you asked Mind to look at lives here; task details never interrupt the conversation.',
      'panel.loops': 'Open threads',
      'panel.facts': 'What we settled',
      'loops.title': 'Open threads',
      'loops.subtitle': 'Threads in the conversation that are not closed yet.',
      'loops.empty': 'Nothing is hanging right now.',
      'facts.title': 'What we settled',
      'facts.subtitle': 'Conclusions we confirmed together. Editing one beats explaining again.',
      'facts.empty': 'Nothing has been written down yet.',
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'miopiik: dictionaries')
        t = ctx.locale.bind(NS)

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'miopiik-presence', order: 40, locale: NS },
            Presence,
          ),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'miopiik-drawer', locale: NS }, Drawer),
        )
      },
    }
  },
})
