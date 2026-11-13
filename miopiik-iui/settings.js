/**
 * MiOpIIk IUI — native DSH Plugins page.
 * Trusted plugin chrome; all styling is theme-aware and independent of model-authored IUI.
 */
const IUI_PREF_KEY = 'miopiik.markdownEmbeds'

const IUI_THEME = Object.freeze({
  fg: 'var(--dsw-alias-label-primary, #e8e9e7)',
  muted: 'var(--dsw-alias-label-secondary, #969e99)',
  border: 'var(--dsw-alias-border-l1, rgba(120,130,120,.25))',
  surface: 'var(--dsw-alias-surface-layer-1, rgba(127,127,127,.045))',
  green: 'var(--dsw-alias-state-success-primary, #78b290)',
  emerald: '#6eae89',
  amber: '#c5a66c',
})

const IUI_PREVIEW_ML = `<ui title="活动概览" fallback="7 日活跃 1,248；30 日活跃 4,826">
  <state name="range" value='{"total":"1,248","change":"+12.6%","points":[["一",92],["二",118],["三",105],["四",148],["五",167],["六",191],["日",220]]}'/>
  <column>
    <metric label="活跃访问" value="$state.range.total" unit="次" delta="$state.range.change"/>
    <segmented bind="$state.range" options='[{"label":"近 7 天","value":{"total":"1,248","change":"+12.6%","points":[["一",92],["二",118],["三",105],["四",148],["五",167],["六",191],["日",220]]}},{"label":"近 30 天","value":{"total":"4,826","change":"+8.3%","points":[["第1周",940],["第2周",1080],["第3周",1275],["第4周",1531]]}}]'/>
    <chart kind="line" series="$state.range.points" source="虚构演示数据"/>
  </column>
</ui>`
const IUI_SAMPLE_MARKDOWN = String.fromCharCode(96).repeat(3) + 'iui\n' + IUI_PREVIEW_ML + '\n' + String.fromCharCode(96).repeat(3)

function iuiIsEnabled() {
  try { return localStorage.getItem(IUI_PREF_KEY) !== '0' } catch { return true }
}

function IuiSettingsPill(text, active = false) {
  return h('span', {
    style: {
      display: 'inline-flex', alignItems: 'center', gap: 6,
      borderRadius: 999, padding: '4px 9px', fontSize: 10,
      fontWeight: 600, lineHeight: '16px', whiteSpace: 'nowrap',
      border: '1px solid ' + (active ? 'rgba(110,174,137,.30)' : IUI_THEME.border),
      background: active ? 'rgba(110,174,137,.10)' : IUI_THEME.surface,
      color: active ? IUI_THEME.green : IUI_THEME.muted,
    },
  }, active ? h('span', { 'aria-hidden': true, style: { width: 5, height: 5, borderRadius: '50%', background: IUI_THEME.green } }) : null, text)
}

function IuiFeature(name, description, glyph) {
  return h('div', {
    style: { display: 'flex', alignItems: 'flex-start', gap: 11, padding: '12px 1px', minWidth: 0 },
  },
    h('span', {
      'aria-hidden': true,
      style: {
        fontSize: 17, fontWeight: 600, lineHeight: '28px', textAlign: 'center',
        color: IUI_THEME.green, background: 'rgba(110,174,137,.09)',
        width: 30, height: 30, flex: '0 0 30px', borderRadius: 9,
      },
    }, glyph),
    h('div', { style: { minWidth: 0 } },
      h('div', { style: { fontSize: 12, fontWeight: 650, color: IUI_THEME.fg, lineHeight: '17px' } }, name),
      h('div', { style: { fontSize: 11, color: IUI_THEME.muted, lineHeight: 1.6, marginTop: 3 } }, description),
    ),
  )
}

function IuiPluginSettings({ view }) {
  const [enabled, setEnabled] = React.useState(iuiIsEnabled)
  const [error, setError] = React.useState('')
  const [showSource, setShowSource] = React.useState(false)
  const [copyMessage, setCopyMessage] = React.useState('')
  if (view !== 'page') return null

  const registry = globalThis.__miopiikMarkdownEmbeds
  const ready = typeof registry?.renderBlock === 'function' && typeof registry?.renderInline === 'function'
  const preview = enabled && ready ? registry.renderBlock(IUI_PREVIEW_ML) : null
  const copySample = async () => {
    try {
      if (!globalThis.navigator?.clipboard?.writeText) throw new Error('clipboard unavailable')
      await globalThis.navigator.clipboard.writeText(IUI_SAMPLE_MARKDOWN)
      setCopyMessage('已复制可直接发送的 IUI 示例')
    } catch {
      setCopyMessage('复制不可用，请手动选择下方文本')
    }
  }
  const card = { border: '1px solid ' + IUI_THEME.border, borderRadius: 15, background: IUI_THEME.surface }
  const caption = { color: IUI_THEME.muted, fontSize: 11, lineHeight: 1.7 }

  const toggle = () => {
    const next = !enabled
    try {
      localStorage.setItem(IUI_PREF_KEY, next ? '1' : '0')
      setEnabled(next)
      setError('')
      // The host memoizes Markdown nodes: refresh to rehydrate historical messages.
      if (typeof location !== 'undefined' && typeof location.reload === 'function') location.reload()
    } catch {
      setError('无法保存设置。请检查此网站的浏览器存储权限。')
    }
  }

  return h('div', {
    'data-iui-plugin-settings': '1',
    style: {
      display: 'flex', flexDirection: 'column', gap: 18,
      width: '100%', maxWidth: 820, minWidth: 0,
      boxSizing: 'border-box', color: IUI_THEME.fg,
      padding: '2px 0 22px', fontFamily: 'inherit',
    },
  },
    // Editorial header, no competing primary navigation.
    h('header', {
      style: {
        position: 'relative', overflow: 'hidden', borderRadius: 16,
        border: '1px solid ' + IUI_THEME.border,
        padding: '23px clamp(17px, 4vw, 28px)',
        background: 'linear-gradient(115deg, rgba(110,174,137,.085), transparent 74%), ' + IUI_THEME.surface,
      },
    },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 15 } },
        h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 9 } },
          h('div', { 'aria-hidden': true, style: { width: 24, height: 24, borderRadius: 8, background: 'linear-gradient(140deg, #8bbb9b, #597963)', display: 'grid', placeItems: 'center', color: '#fff', fontSize: 12, fontWeight: 750 } }, 'i'),
          h('span', { style: { fontSize: 11, fontWeight: 700, letterSpacing: 1.1, color: IUI_THEME.muted } }, 'MIOPIIK  /  IUI'),
        ),
        IuiSettingsPill('v' + IUI_PLUGIN_VERSION + ' · RC'),
      ),
      h('div', { style: { fontWeight: 710, letterSpacing: '-.035em', lineHeight: 1.25, fontSize: 'clamp(19px, 3.3vw, 26px)', marginBottom: 9 } }, '让界面像文字一样自然。'),
      h('p', { style: { ...caption, maxWidth: 610, fontSize: 12, margin: 0 } },
        '在 DSH 原生对话中，按需呈现状态、可视化与本地交互。无需绘图工具，也不需要让模型分心研究渲染器。',
      ),
    ),

    // The single authoritative, real setting.
    h('section', { style: { ...card, padding: '18px clamp(15px, 3vw, 22px)' } },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5, flex: '1 1 220px' } },
          h('span', { style: { fontSize: 11, fontWeight: 650, letterSpacing: .4, color: IUI_THEME.muted } }, '渲染设置'),
          h('strong', { style: { fontSize: 15, letterSpacing: '-.01em' } }, '在聊天中显示 IUI'),
          h('span', { 'data-iui-settings-status': enabled ? 'enabled' : 'disabled', style: { ...caption } },
            enabled ? '已开启 · 仅作用于当前浏览器' : '已关闭 · IUI 围栏将显示为普通代码块'),
        ),
        h('button', {
          type: 'button', role: 'switch',
          'data-iui-settings-toggle': '1',
          'aria-label': '在聊天中显示 IUI',
          'aria-checked': enabled,
          onClick: toggle,
          style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-start',
            flex: '0 0 auto', width: 47, height: 27, borderRadius: 999,
            border: '1px solid ' + (enabled ? 'rgba(110,174,137,.65)' : IUI_THEME.border),
            background: enabled ? IUI_THEME.emerald : 'rgba(127,127,127,.22)',
            padding: 3, cursor: 'pointer', transition: 'background .15s ease',
          },
        },
          h('span', { 'aria-hidden': true, style: { width: 19, height: 19, borderRadius: 999, background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.2)', transform: enabled ? 'translateX(19px)' : 'translateX(0)', transition: 'transform .15s ease' } }),
        ),
      ),
      h('div', { style: { height: 1, background: IUI_THEME.border, margin: '17px 0 14px' } }),
      h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
        IuiSettingsPill(ready ? '渲染器已连接' : '渲染器未就绪', ready),
        IuiSettingsPill('受限声明式组件'),
        IuiSettingsPill('本地交互'),
      ),
      error ? h('p', { role: 'alert', style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #d1242f)', marginBottom: 0 } }, error) : null,
    ),

    // Preview is the actual IUI renderer, not a fake screenshot.
    h('section', { style: { ...card, padding: '17px clamp(15px, 3vw, 22px)' } },
      h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 9, marginBottom: 13 } },
        h('div', null,
          h('h3', { style: { fontSize: 14, margin: '0 0 4px', fontWeight: 680 } }, '实时预览'),
          h('p', { style: { ...caption, margin: 0 } }, '使用真实 IUI 渲染器。点击周期切换，数据会在本地更新。'),
        ),
        IuiSettingsPill('无需模型请求'),
      ),
      h('div', {
        'data-iui-settings-preview': preview ? 'live' : 'paused',
        style: { border: '1px solid ' + IUI_THEME.border, borderRadius: 12, padding: '12px clamp(9px, 2vw, 17px)', background: 'var(--dsw-alias-surface-default, transparent)', minHeight: 142, minWidth: 0, overflow: 'hidden' },
      },
        preview ?? h('div', { role: 'status', style: { minHeight: 142, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 5, color: IUI_THEME.muted } },
          h('strong', { style: { fontSize: 12, fontWeight: 650 } }, enabled ? '渲染器未连接' : '预览已暂停'),
          h('span', { style: { fontSize: 11, textAlign: 'center' } }, enabled ? '请检查插件加载状态后刷新页面。' : '重新开启 IUI，即可恢复实时预览。'),
        ),
      ),
      h('div', { style: { marginTop: 12, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' } },
        h('span', { style: { fontSize: 10, fontWeight: 650, color: IUI_THEME.muted, letterSpacing: .3 } }, '行内语义'),
        ready ? registry.renderInline({ type: 'badge', props: { tone: 'success', text: '已完成' } }) : null,
        ready ? registry.renderInline({ type: 'badge', props: { tone: 'warning', text: '进行中' } }) : null,
        h('code', { style: { fontSize: 11, color: IUI_THEME.muted, padding: '1px 5px', background: IUI_THEME.surface, borderRadius: 5 } }, 'iui/1'),
      ),
      h('div', { style: { marginTop: 12, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 9 } },
        h('button', { type: 'button', 'data-iui-source-toggle': '1', 'aria-expanded': showSource,
          onClick: () => setShowSource(!showSource),
          style: { border: '1px solid ' + IUI_THEME.border, borderRadius: 8, padding: '6px 11px', background: 'transparent', color: IUI_THEME.fg, cursor: 'pointer', fontSize: 11 } },
          showSource ? '收起声明' : '查看 IUI 声明'),
        h('span', { style: { ...caption, fontSize: 10 } }, '可以直接在 DSH 会话中测试这份示例'),
      ),
      showSource ? h('div', { 'data-iui-preview-source': '1', style: { marginTop: 11, display: 'flex', flexDirection: 'column', gap: 9 } },
        h('pre', { style: { margin: 0, padding: 12, borderRadius: 10, border: '1px solid ' + IUI_THEME.border, background: IUI_THEME.surface, color: IUI_THEME.fg, overflowX: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 11, lineHeight: 1.65 } }, IUI_SAMPLE_MARKDOWN),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('button', { type: 'button', 'data-iui-copy-source': '1', onClick: copySample,
            style: { border: '1px solid ' + IUI_THEME.border, borderRadius: 8, padding: '6px 11px', background: 'transparent', color: IUI_THEME.fg, cursor: 'pointer', fontSize: 11 } }, '复制示例'),
          h('span', { role: 'status', style: caption }, copyMessage),
        ),
      ) : null,
    ),

    h('section', { style: { padding: '1px 2px' } },
      h('h3', { style: { fontSize: 13, margin: '0 0 6px', fontWeight: 680 } }, '表达能力'),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 210px), 1fr))', gap: '0 18px' } },
        IuiFeature('自然混排', '状态标签和文字出现在同一条回复中。', 'Aa'),
        IuiFeature('数据可视化', '图表、指标、表格由统一协议渲染。', '▥'),
        IuiFeature('本地交互', '切换状态不触发新的模型调用。', '↔'),
      ),
    ),

    h('section', { style: { borderTop: '1px solid ' + IUI_THEME.border, padding: '15px 1px 0' } },
      h('h3', { style: { fontSize: 12, margin: '0 0 11px', fontWeight: 680 } }, '运行信息'),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 225px), 1fr))', gap: '9px 20px' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 9, ...caption } }, h('span', null, '协议'), h('code', { style: { color: IUI_THEME.fg } }, 'iui/1 · miopiik-ml')),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 9, ...caption } }, h('span', null, '客户端'), h('span', { 'data-iui-registry-state': ready ? 'ready' : 'unavailable', style: { color: ready ? IUI_THEME.green : IUI_THEME.amber } }, ready ? '已连接' : '未连接')),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 9, ...caption } }, h('span', null, '插件'), h('code', { style: { color: IUI_THEME.fg } }, 'miopiik-iui')),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 9, ...caption } }, h('span', null, '模式'), h('span', null, 'DSH Web 扩展')),
      ),
      h('p', { style: { ...caption, fontSize: 10, margin: '12px 0 0' } },
        '此版本使用实验性 DSH Markdown 接入补丁。开关仅控制当前浏览器的渲染，不会停用 Host 的模型输出指引。切换会刷新页面，但不会改写历史消息。',
      ),
    ),
  )
}

function registerIuiSettings(ctx) {
  if (!ctx.slots || typeof ctx.slots.inject !== 'function') return
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: 'miopiik-iui',
  }, (props) => h(IuiPluginSettings, props ?? {})))
}
