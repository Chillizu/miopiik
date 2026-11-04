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
      const known = ['loops', 'facts', 'running', 'drafts', 'letter', 'audit']
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
            { role: 'tablist', style: { display: 'flex', gap: 8 } },
            h(TabButton, { id: 'loops', label: t('tab.loops'), active: tab === 'loops' }),
            h(TabButton, { id: 'facts', label: t('tab.facts'), active: tab === 'facts' }),
            h(TabButton, { id: 'running', label: t('tab.running'), active: tab === 'running' }),
            h(TabButton, { id: 'drafts', label: t('tab.drafts'), active: tab === 'drafts' }),
            h(TabButton, { id: 'letter', label: t('tab.letter'), active: tab === 'letter' }),
          ),
          tab === 'loops'
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
      'branches.title': '鱼骨分支（从哪句话长出来的事）',
      'branches.empty': '现在没有分支。',
      'branches.noSummary': '还没写一句话',
      'branches.jobs': '个任务',
      'settings.title': 'MiOpIIk',
      'settings.intro': '这些是后台（Ink）的可调项。默认值就够用，改之前先想清楚要换掉哪个判断。',
      'settings.where': '改法：编辑 profile 的 cordis.patch.yml，在 miopiik-dsh 的 config 段里写要覆盖的字段，保存后热重载生效。',
      'settings.followSession': '跟随会话默认',
      'settings.hotReload': '本页只读：配置以文件为准，避免界面上改出和文件不一致的第二份真相。',
      'tab.drafts': '草稿',
      'tab.letter': '今天的信',
      'drafts.subtitle': '没到交付门槛的半成品；一周没人碰会自己消失。',
      'drafts.empty': '现在没有草稿。',
      'letter.subtitle': '今天收工时我写给明天自己的信。',
      'letter.empty': '今天还没有写信。',
      'letter.progress': '推进',
      'letter.loops': '还悬着',
      'letter.running': '在跑',
      'letter.drafts': '草稿',
      'letter.next': '明天想先说',
      'letter.update': '隔夜更新',
      'audit.entry': '取证',
      'audit.back': '收起取证',
      'audit.subtitle': 'Ink 的决定账（审计视图，不是给你日常看的）。',
      'audit.empty': '还没有决定记录。',
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
      'branches.title': 'Branches (what grew out of which sentence)',
      'branches.empty': 'No branches right now.',
      'branches.noSummary': 'no one-liner yet',
      'branches.jobs': 'jobs',
      'settings.title': 'MiOpIIk',
      'settings.intro': 'Knobs of the backstage (Ink). Defaults are fine; think about which judgement you want to change before changing a number.',
      'settings.where': 'How: edit cordis.patch.yml in your profile, under the miopiik-dsh config block, then save — hot reload applies it.',
      'settings.followSession': 'follow session',
      'settings.hotReload': 'Read-only on purpose: the file is the only source, so the UI can never disagree with it.',
      'tab.drafts': 'Drafts',
      'tab.letter': "Today's letter",
      'drafts.subtitle': 'Half-finished work below the commit bar; untouched for a week and it disappears.',
      'drafts.empty': 'No drafts right now.',
      'letter.subtitle': 'The letter I wrote to tomorrow-me when today wrapped up.',
      'letter.empty': 'No letter written today yet.',
      'letter.progress': 'Progress',
      'letter.loops': 'Still open',
      'letter.running': 'Running',
      'letter.drafts': 'Drafts',
      'letter.next': 'Tomorrow, first',
      'letter.update': 'Overnight update',
      'audit.entry': 'Evidence',
      'audit.back': 'Hide evidence',
      'audit.subtitle': 'Ink\'s decision ledger (an audit view, not something to read daily).',
      'audit.empty': 'No decisions recorded yet.',
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
