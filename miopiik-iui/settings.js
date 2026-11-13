/**
 * MiOpIIk IUI — native DSH Plugins page.
 *
 * The official plugin manager declares exactly one bundle-configuration slot
 * (`plugins.bundle.config`). Inside it, this page offers its own Overview /
 * Configuration navigation; it does not declare or simulate a second slot.
 * Trusted plugin chrome only: theme tokens, no gradients, no hero, no fake
 * switches. The one real setting is the browser-local render preference.
 */
const IUI_PREF_KEY = 'miopiik.markdownEmbeds'

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

// 实验补丁是否在宿主侧生效：由 chat 插件 fork 在加载时置位；原生 DSH 不会有这个标记。
function hostPatchActive() {
  try {
    return globalThis.__miopiikMarkdownEmbedsHost === true
  } catch {
    return false
  }
}

// Official primitives when the running DSH shell exposes them; plain token
// elements otherwise so the page never breaks on a foreign shell.
let IUI_PRIMITIVES = null
try {
  IUI_PRIMITIVES = require('@deepseek-ai/dsh-client-ui-primitives')
} catch {
  IUI_PRIMITIVES = null
}
const IuiSegmentedTabs = IUI_PRIMITIVES?.SegmentedTabs
const IuiSwitch = IUI_PRIMITIVES?.Switch
const IuiButton = IUI_PRIMITIVES?.Button

const IUI_PAGE = {
  root: {
    display: 'flex', flexDirection: 'column', gap: 24,
    width: '100%', minWidth: 0, boxSizing: 'border-box',
    color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit',
  },
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
    display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
    gap: 8, flexWrap: 'wrap', padding: '9px 2px', minWidth: 0,
    borderTop: '.5px solid var(--dsw-alias-border-l2)',
  },
  itemLabel: { flex: 'none', fontSize: 13, fontWeight: 500, lineHeight: '20px' },
  itemValue: {
    flex: '0 1 auto', margin: 0, textAlign: 'right', overflowWrap: 'anywhere',
    fontVariantNumeric: 'tabular-nums', fontSize: 12.5, lineHeight: '18px',
    color: 'var(--dsw-alias-label-secondary)',
  },
  mono: {
    fontFamily: 'var(--ds-font-family-code, var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace))',
    fontSize: 11.5, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)',
    overflowWrap: 'anywhere',
  },
  pre: {
    margin: 0, padding: '12px 14px', maxWidth: '100%', overflowX: 'auto',
    border: '.5px solid var(--dsw-alias-border-l1)',
    borderRadius: 'var(--dsw-radius-md)',
    background: 'var(--dsw-alias-bg-module-platform)',
    fontFamily: 'var(--ds-font-family-code, var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace))',
    fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-primary)',
    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
  },
  preview: {
    border: '.5px solid var(--dsw-alias-border-l4)',
    borderRadius: 'var(--dsw-radius-lg)',
    background: 'var(--dsw-alias-bg-layer-1)',
    padding: '12px clamp(9px, 2vw, 17px)', minHeight: 142, minWidth: 0, overflow: 'hidden',
  },
  actions: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
}

const IUI_TABS = [
  { value: 'overview', label: '介绍' },
  { value: 'configuration', label: '配置' },
]

// Native page tabs sit at their content width (min 240px), not stretched.
function installIuiSettingsStyle(ctx) {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-miopiik-iui-settings-style]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.miopiikIuiSettingsStyle = '1'
  tag.textContent = '[data-iui-plugin-settings="1"] [role="tablist"]{width:fit-content;max-width:100%;min-width:240px}'
  document.head.appendChild(tag)
  if (typeof ctx.effect === 'function') ctx.effect(() => () => tag.remove(), 'miopiik-iui: settings style')
}

function IuiTabs({ value, onChange }) {
  if (IuiSegmentedTabs) {
    return h(IuiSegmentedTabs, {
      id: 'miopiik-iui-settings-tabs',
      label: 'MiOpIIk IUI 插件页',
      value,
      onChange,
      items: IUI_TABS.map((tab) => ({
        ...tab,
        id: 'miopiik-iui-settings-tab-' + tab.value,
        panelId: 'miopiik-iui-settings-panel-' + tab.value,
      })),
    })
  }
  return h(
    'div',
    {
      role: 'tablist',
      'aria-label': 'MiOpIIk IUI 插件页',
      style: {
        display: 'inline-flex', gap: 2, padding: 4, width: 'fit-content', maxWidth: '100%',
        borderRadius: 'var(--dsw-radius-md)', background: 'var(--dsw-alias-interactive-bg-hover)',
      },
    },
    IUI_TABS.map((tab) => {
      const active = value === tab.value
      return h(
        'button',
        {
          key: tab.value,
          type: 'button',
          role: 'tab',
          'aria-selected': active,
          'data-iui-tab': tab.value,
          onClick: () => onChange(tab.value),
          style: {
            height: 28, padding: '0 16px', border: 0,
            borderRadius: 'var(--dsw-radius-sm)',
            background: active ? 'var(--dsw-alias-bg-layer-1)' : 'transparent',
            color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
            font: 'inherit', fontSize: 13, fontWeight: 500, lineHeight: '20px', cursor: 'pointer',
          },
        },
        tab.label,
      )
    }),
  )
}

function IuiActionButton({ onClick, children }) {
  if (IuiButton) return h(IuiButton, { variant: 'outline', size: 'sm', onClick }, children)
  return h(
    'button',
    {
      type: 'button',
      onClick,
      style: {
        height: 28, padding: '0 10px',
        border: '.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 'var(--dsw-radius-md)', background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)', font: 'inherit', fontSize: 12.5, cursor: 'pointer',
      },
    },
    children,
  )
}

function IuiToggle({ enabled, onToggle }) {
  if (IuiSwitch) {
    return h(IuiSwitch, { checked: enabled, onChange: onToggle, label: '在聊天中显示 IUI', title: '在聊天中显示 IUI' })
  }
  return h(
    'button',
    {
      type: 'button',
      role: 'switch',
      'aria-checked': enabled,
      'aria-label': '在聊天中显示 IUI',
      'data-iui-settings-toggle': '1',
      onClick: onToggle,
      style: {
        boxSizing: 'border-box', position: 'relative', flex: '0 0 auto',
        width: 36, height: 20, padding: 2, border: 0, borderRadius: 999,
        background: enabled ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l3)',
        cursor: 'pointer',
      },
    },
    h('span', {
      'aria-hidden': true,
      style: {
        display: 'block', width: 16, height: 16, borderRadius: '50%',
        background: enabled ? 'var(--dsw-alias-label-primary-foreground)' : 'var(--dsw-alias-switch-thumb)',
        transform: enabled ? 'translateX(16px)' : 'translateX(0)',
        transition: 'transform .12s ease',
      },
    }),
  )
}

function IuiFact({ label, value, mono = false, badge = null }) {
  return h(
    'div',
    { style: { ...IUI_PAGE.item } },
    h('dt', { style: IUI_PAGE.itemLabel }, label),
    h('dd', { style: { ...(mono ? IUI_PAGE.mono : IUI_PAGE.itemValue), margin: 0, textAlign: 'right' } }, badge ?? value),
  )
}

function IuiOverview({ preview, enabled, ready, registry }) {
  return h(
    'div',
    { 'data-iui-overview': '1', style: { display: 'flex', flexDirection: 'column', gap: 32, minWidth: 0 } },
    h(
      'section',
      { style: IUI_PAGE.section },
      h(
        'p',
        { style: IUI_PAGE.body },
        'IUI 是一种声明式 Markdown 界面：模型在回复里直接书写受控的 iui 围栏或行内标记，DSH 用本地渲染器把它变成状态、可视化与本地交互。它不是工具调用，也不要求模型了解渲染器实现。',
      ),
    ),
    h(
      'section',
      { style: IUI_PAGE.section },
      h('h3', { style: IUI_PAGE.title }, '实时预览'),
      h('p', { style: IUI_PAGE.hint }, '使用真实的 IUI 渲染器，不截图、不伪造数据。切换周期只改本地状态，不发起模型请求。'),
      h(
        'div',
        { 'data-iui-settings-preview': preview ? 'live' : 'paused', style: IUI_PAGE.preview },
        preview ??
          h(
            'div',
            { role: 'status', style: { minHeight: 142, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 5, color: 'var(--dsw-alias-label-tertiary)' } },
            h('strong', { style: { fontSize: 12, fontWeight: 650 } }, enabled ? '渲染器未连接' : '预览已暂停'),
            h('span', { style: { fontSize: 11, textAlign: 'center', overflowWrap: 'anywhere' } }, enabled ? '请检查插件加载状态后刷新页面。' : '在「配置」中开启渲染后即可恢复预览。'),
          ),
      ),
      h(
        'div',
        { style: { marginTop: 12, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' } },
        h('span', { style: { fontSize: 10, fontWeight: 650, color: 'var(--dsw-alias-label-tertiary)', letterSpacing: .3 } }, '行内语义'),
        ready ? registry.renderInline({ type: 'badge', props: { tone: 'success', text: '已完成' } }) : null,
        ready ? registry.renderInline({ type: 'badge', props: { tone: 'warning', text: '进行中' } }) : null,
        h('code', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', padding: '1px 5px', background: 'var(--dsw-alias-bg-module-platform)', borderRadius: 5 } }, 'iui/1'),
      ),
    ),
    h(
      'section',
      { style: IUI_PAGE.section },
      h('h3', { style: IUI_PAGE.title }, '兼容性与边界'),
      h(
        'dl',
        { style: IUI_PAGE.list },
        h(IuiFact, { label: '版本', value: 'v' + IUI_PLUGIN_VERSION }),
        h(IuiFact, { label: '协议', value: 'iui/1 · miopiik-ml', mono: true }),
        h(IuiFact, {
          label: '接入方式',
          value: '实验性 DSH Chat Markdown 补丁（尚未合并进上游 API）',
        }),
        h(IuiFact, {
          label: '渲染器',
          value: ready ? '已连接' : '未连接',
          badge: h('span', {
            'data-iui-registry-state': ready ? 'ready' : 'unavailable',
            style: { color: ready ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)' },
          }, ready ? '已连接' : '未连接'),
        }),
        h(IuiFact, {
          label: '安全边界',
          value: '仅白名单组件；无任意 HTML/JS/CSS、无网络请求、无工具调用；坏节点只在本地降级',
        }),
        h(IuiFact, {
          label: '与 MiOpIIk Agent 的关系',
          value: '独立插件；不需要 Mind/Ink/Operator，Agent 也不需要它',
        }),
      ),
    ),
  )
}

function IuiConfiguration({ enabled, ready, error, toggle, copySample, copyMessage }) {
  return h(
    'div',
    { 'data-iui-configuration': '1', style: { display: 'flex', flexDirection: 'column', gap: 32, minWidth: 0 } },
    h(
      'section',
      { style: IUI_PAGE.section },
      h('h3', { style: IUI_PAGE.title }, '渲染设置'),
      h(
        'div',
        { style: { ...IUI_PAGE.item, borderTop: 0, padding: '4px 2px', alignItems: 'center' } },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 240px', minWidth: 0 } },
          h('span', { style: IUI_PAGE.itemLabel }, '在聊天中显示 IUI'),
          h('span', { 'data-iui-settings-status': enabled ? 'enabled' : 'disabled', style: { ...IUI_PAGE.hint, color: 'var(--dsw-alias-label-secondary)' } },
            enabled ? '已开启 · 仅作用于当前浏览器' : '已关闭 · iui 围栏显示为普通代码块'),
          h('span', { style: IUI_PAGE.hint }, '切换后会刷新页面，让历史消息按新偏好重新渲染；不会改写任何历史数据。'),
        ),
        h(IuiToggle, { enabled, onToggle: toggle }),
      ),
      error ? h('p', { role: 'alert', style: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
    ),
    h(
      'section',
      { style: IUI_PAGE.section },
      h('h3', { style: IUI_PAGE.title }, '诊断'),
      h(
        'dl',
        { style: IUI_PAGE.list },
        h(IuiFact, {
          label: '渲染器',
          value: ready ? '已连接' : '未连接',
          badge: h('span', {
            'data-iui-registry-state': ready ? 'ready' : 'unavailable',
            style: { color: ready ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)' },
          }, ready ? '已连接' : '未连接'),
        }),
        h(IuiFact, { label: '插件版本', value: 'v' + IUI_PLUGIN_VERSION }),
        h(IuiFact, { label: '协议', value: 'iui/1 · miopiik-ml', mono: true }),
        h(IuiFact, { label: '浏览器偏好', value: IUI_PREF_KEY, mono: true }),
        h(IuiFact, { label: '当前偏好', value: enabled ? '开启' : '关闭' }),
        h(IuiFact, { label: '接入方式', value: hostPatchActive() ? '实验性 DSH Chat Markdown 补丁（已加载）' : '未检测到补丁 · 仅设置页预览可用' }),
      ),
      h('p', { style: IUI_PAGE.hint }, '此版本使用实验性 DSH Markdown 接入补丁。开关只控制当前浏览器的渲染，不会停用 Host 的模型输出指引。'),
    ),
    h(
      'section',
      { style: IUI_PAGE.section },
      h('h3', { style: IUI_PAGE.title }, '示例与复制'),
      h('p', { style: IUI_PAGE.hint }, '下面这份 Markdown 可以直接粘贴到 DSH 会话中测试。'),
      h('pre', { 'data-iui-preview-source': '1', style: IUI_PAGE.pre }, IUI_SAMPLE_MARKDOWN),
      h(
        'div',
        { style: IUI_PAGE.actions },
        h(IuiActionButton, { onClick: copySample }, '复制示例'),
        h('span', { role: 'status', 'data-iui-copy-status': '1', style: IUI_PAGE.hint }, copyMessage),
      ),
    ),
  )
}

function IuiPluginSettings({ view, initialTab }) {
  const [tab, setTab] = React.useState(initialTab ?? 'overview')
  const [enabled, setEnabled] = React.useState(iuiIsEnabled)
  const [error, setError] = React.useState('')
  const [copyMessage, setCopyMessage] = React.useState('')
  if (view !== 'page') return null

  const registry = globalThis.__miopiikMarkdownEmbeds
  const ready = typeof registry?.renderBlock === 'function' && typeof registry?.renderInline === 'function'
  const preview = enabled && ready ? registry.renderBlock(IUI_PREVIEW_ML) : null

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
  const copySample = async () => {
    try {
      if (!globalThis.navigator?.clipboard?.writeText) throw new Error('clipboard unavailable')
      await globalThis.navigator.clipboard.writeText(IUI_SAMPLE_MARKDOWN)
      setCopyMessage('已复制可直接发送的 IUI 示例')
    } catch {
      setCopyMessage('复制不可用，请手动选择下方文本')
    }
  }

  return h(
    'div',
    {
      'data-iui-plugin-settings': '1',
      style: IUI_PAGE.root,
    },
    h(IuiTabs, { value: tab, onChange: setTab }),
    tab === 'configuration'
      ? h(IuiConfiguration, { enabled, ready, error, toggle, copySample, copyMessage })
      : h(IuiOverview, { preview, enabled, ready, registry }),
  )
}

function registerIuiSettings(ctx) {
  if (!ctx.slots || typeof ctx.slots.inject !== 'function') return
  installIuiSettingsStyle(ctx)
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: 'miopiik-iui',
  }, (props) => h(IuiPluginSettings, props ?? {})))
}
