/**
 * miopiik-dsh — Client 半边（Web）。
 *
 * Batch 1：只做「存在感」与「可拉出的窗口」，不做导航栏（SPEC §6）。
 *  - conversation.composer.dock —— 极轻的后台存在感指示
 *  - shell.overlay              —— 「后台在跑」抽屉
 *  - sidebar.panellist + main   —— 「悬着的事」「我们一起定的」两个页面（占位）
 *
 * 所有可见文案走 Client locale；样式只用 host 主题 token（--dsw-alias-*）。
 */
window.__ModuleLoader__.load({
  id: 'miopiik-dsh',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'miopiik'

    // ── 极小的共享状态：指示器与抽屉是同一次渲染里的两个座位 ──────────────
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

    const overlay = createStore({ open: false })

    const useStore = React.useSyncExternalStore
      ? (store) => React.useSyncExternalStore(store.subscribe, store.get)
      : (store) => {
          const [, force] = React.useReducer((n) => n + 1, 0)
          React.useEffect(() => store.subscribe(force), [store])
          return store.get()
        }

    // apply() 里绑定，组件渲染时已可用
    let t = (key) => key

    const C = {
      overlay: 'var(--dsw-alias-bg-overlay)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
    }

    // ── 存在感：极轻的一行，点开抽屉 ─────────────────────────────────────
    function Presence() {
      const state = useStore(overlay)
      const running = state.count > 0
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
          style: {
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: running ? C.success : C.idle,
            flex: 'none',
          },
        }),
        h('span', null, running ? `${t('presence.running')} ${state.count}` : t('presence.idle')),
      )
    }

    // ── 抽屉：后台在跑什么 ──────────────────────────────────────────────
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
      return h(
        'div',
        {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('drawer.title'),
          onClick: close,
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 60,
            background: 'rgba(0, 0, 0, 0.32)',
          },
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
            {
              style: {
                border: `1px dashed ${C.border}`,
                borderRadius: 10,
                padding: '18px 16px',
                color: C.muted,
                lineHeight: '20px',
              },
            },
            h('div', null, t('drawer.empty')),
            h('div', { style: { marginTop: 6, fontSize: 12 } }, t('drawer.hint')),
          ),
        ),
      )
    }

    // ── 两个页面（占位；Batch 5 接真实数据与干预） ──────────────────────
    function page(titleKey, subtitleKey, emptyKey) {
      return function Page() {
        return h(
          'div',
          {
            style: {
              maxWidth: 720,
              margin: '0 auto',
              padding: '32px 28px 48px',
              color: C.text,
            },
          },
          h('h1', { style: { margin: 0, fontSize: 18, fontWeight: 600 } }, t(titleKey)),
          h('p', { style: { margin: '6px 0 0', fontSize: 13, color: C.muted } }, t(subtitleKey)),
          h(
            'div',
            {
              style: {
                marginTop: 24,
                border: `1px dashed ${C.border}`,
                borderRadius: 10,
                padding: '22px 18px',
                color: C.muted,
                fontSize: 13,
              },
            },
            t(emptyKey),
          ),
        )
      }
    }

    const LoopsPage = page('loops.title', 'loops.subtitle', 'loops.empty')
    const FactsPage = page('facts.title', 'facts.subtitle', 'facts.empty')

    // ── 面板图标：鱼骨上的环 / 一颗墨点 ────────────────────────────────
    function LoopIcon() {
      return h(
        'svg',
        { viewBox: '0 0 20 20', width: 18, height: 18, fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M10 3.2a6.8 6.8 0 1 1-6.6 8.4',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
        }),
        h('circle', { cx: 3.8, cy: 11.6, r: 1.6, fill: 'currentColor' }),
      )
    }

    function FactIcon() {
      return h(
        'svg',
        { viewBox: '0 0 20 20', width: 18, height: 18, fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M5 2.8h6.4L15 6.4v10.8H5z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M7.2 11.2l1.9 1.9 3.7-3.9',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    const zh = {
      'presence.idle': '后台安静',
      'presence.running': '后台在跑',
      'presence.title': '看一眼后台',
      'drawer.title': '后台在跑',
      'drawer.empty': '现在没有在跑的东西。',
      'drawer.hint': '有任务时，这里显示状态和叫停入口。',
      'drawer.close': '关闭',
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
      'presence.idle': 'Backstage quiet',
      'presence.running': 'Backstage',
      'presence.title': 'Look at the backstage',
      'drawer.title': 'Backstage',
      'drawer.empty': 'Nothing is running right now.',
      'drawer.hint': 'When something runs, its state and a stop control appear here.',
      'drawer.close': 'Close',
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

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'miopiik-loops', locale: NS }, LoopsPage),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'miopiik-facts', locale: NS }, FactsPage),
        )

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'miopiik-loops',
              order: 20,
              locale: NS,
              label: () => t('panel.loops'),
            },
            LoopIcon,
          ),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'miopiik-facts',
              order: 21,
              locale: NS,
              label: () => t('panel.facts'),
            },
            FactIcon,
          ),
        )
      },
    }
  },
})
