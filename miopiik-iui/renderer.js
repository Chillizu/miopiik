/**
 * Standalone IUI renderer extracted from the verified MiOpIIk RC.
 * Scope: React h/React, IUI_AST, MIOPIIK_ML, C, SANS. No legacy Widget/Ink deps.
 * This source is bundled verbatim into client.js by tools/build.mjs.
 */
    function svgCanvas(width, height, children, label) {
      return h(
        'svg',
        {
          viewBox: `0 0 ${width} ${height}`,
          width,
          height,
          preserveAspectRatio: 'xMidYMid meet',
          role: 'img',
          'aria-label': label === undefined || label === '' ? undefined : label,
          style: { display: 'block', maxWidth: '100%', height: 'auto', margin: '0 auto', overflow: 'visible' },
        },
        ...children,
      )
    }

    const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'

    function renderChart(columns, rows, kind) {
      const values = rows.map((row) => Number(row[1]) || 0)
      const max = Math.max(1, ...values)
      const labels = rows.map((row) => String(row[0] ?? ''))
      if (kind === 'line') {
        const width = 360
        const height = 128
        const padL = 8
        const padR = 8
        const padT = 18
        const padB = 22
        const step = rows.length > 1 ? (width - padL - padR) / (rows.length - 1) : 0
        const points = values.map((value, index) => ({
          x: padL + index * step,
          y: height - padB - (value / max) * (height - padB - padT),
        }))
        const parts = []
        parts.push(h('line', { key: 'axis', x1: padL, y1: height - padB, x2: width - padR, y2: height - padB, stroke: C.border, strokeWidth: 1 }))
        parts.push(
          h('polyline', {
            key: 'line',
            points: points.map((point) => `${point.x},${point.y}`).join(' '),
            fill: 'none',
            stroke: C.brand,
            strokeWidth: 2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        )
        points.forEach((point, index) => {
          parts.push(h('circle', { key: `dot-${index}`, cx: point.x, cy: point.y, r: 3, fill: C.brand }))
          parts.push(
            h('text', { key: `val-${index}`, x: point.x, y: point.y - 8, fontSize: 9, fill: C.text, fontFamily: SANS, textAnchor: 'middle' }, String(values[index])),
          )
          parts.push(
            h('text', { key: `lab-${index}`, x: point.x, y: height - 7, fontSize: 8.5, fill: C.muted, fontFamily: SANS, textAnchor: 'middle' }, labels[index]),
          )
        })
        return svgCanvas(width, height, parts)
      }
      if (kind === 'donut') {
        const size = 124
        const radius = 42
        const thickness = 16
        const total = values.reduce((sum, value) => sum + value, 0) || 1
        const circumference = 2 * Math.PI * radius
        let offset = 0
        const palette = [C.brand, C.success, C.warn, C.idle, C.error]
        const arcs = values.map((value, index) => {
          const length = (value / total) * circumference
          const arc = h('circle', {
            key: `arc-${index}`,
            cx: size / 2,
            cy: size / 2,
            r: radius,
            fill: 'none',
            stroke: palette[index % palette.length],
            strokeWidth: thickness,
            strokeDasharray: `${Math.max(0, length - 2)} ${circumference}`,
            strokeDashoffset: -offset,
            transform: `rotate(-90 ${size / 2} ${size / 2})`,
            strokeLinecap: 'butt',
          })
          offset += length
          return arc
        })
        return h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' } },
          h('div', { style: { width: size, flex: 'none' } }, svgCanvas(size, size, arcs)),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11 } },
            ...labels.map((label, index) =>
              h(
                'div',
                { key: index, style: { display: 'flex', alignItems: 'center', gap: 6 } },
                h('span', { style: { width: 8, height: 8, borderRadius: 2, background: palette[index % palette.length], flex: 'none' } }),
                h('span', { style: { color: C.text } }, label),
                h('span', { style: { color: C.muted } }, String(values[index])),
              ),
            ),
          ),
        )
      }
      const chartHeight = 96
      const axis = h(
        'div',
        { key: 'plot', style: { display: 'flex', alignItems: 'flex-end', gap: 10, height: chartHeight, borderBottom: `1px solid ${C.border}` } },
        ...rows.map((row, index) =>
          h(
            'div',
            { key: `bar-${index}`, style: { flex: '1 1 0', minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', gap: 3 } },
            h('div', { style: { fontSize: 10, color: C.text, lineHeight: '12px' } }, String(values[index])),
            h('div', {
              style: {
                width: '100%',
                maxWidth: 52,
                height: Math.max(2, Math.round((values[index] / max) * (chartHeight - 18))),
                background: C.brand,
                borderRadius: '3px 3px 0 0',
              },
            }),
          ),
        ),
      )
      const labelsRow = h(
        'div',
        { key: 'labels', style: { display: 'flex', gap: 10, marginTop: 5 } },
        ...labels.map((label, index) =>
          h(
            'div',
            { key: `lab-${index}`, style: { flex: '1 1 0', minWidth: 0, textAlign: 'center', fontSize: 10, color: C.muted, lineHeight: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            label,
          ),
        ),
      )
      return h('div', { style: { display: 'flex', flexDirection: 'column', width: '100%' } }, axis, labelsRow)
    }

    function IuiSheet({ sample, format, degraded }) {
      const checked = IUI_AST.validateAst(sample)
      // 依赖必须是**内容**而不是对象引用：正文每次渲染都会产生新对象，用引用会导致状态被重置。
      const sampleKey = React.useMemo(() => {
        try {
          return JSON.stringify(checked.ok ? { state: checked.ast.state, root: checked.ast.root } : sample)
        } catch {
          return String(sample)
        }
      }, [sample])
      const [state, setState] = React.useState(checked.ok ? checked.ast.state : {})
      React.useEffect(() => {
        if (checked.ok) setState(checked.ast.state)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sampleKey])
      const degradedCount = (Array.isArray(degraded) ? degraded.length : 0) + (checked.ok ? checked.degraded : 0)
      if (!checked.ok) {
        return h(
          'div',
          { 'data-iui-output': 'invalid', 'data-iui-format': format ?? 'json', style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, lineHeight: '18px' } },
          h('div', { style: { color: C.muted } }, '这份 AST 不合法，已整段降级：'),
          h('div', null, checked.fallback || checked.errors[0]),
        )
      }
      const ast = checked.ast
      const scope = { state, data: {} }
      const resolve = (value) => IUI_AST.resolveValue(value, scope)
      const node = (item, key) => {
        const props = item.props ?? {}
        if (item.type === 'text') {
          return h('div', { key, style: { fontSize: 12, lineHeight: '18px', color: C.text } }, String(resolve(props.text) ?? ''))
        }
        if (item.type === 'divider') {
          if (!props.label) return h('hr', { key, 'data-iui-divider': '1', style: { border: 'none', borderTop: `1px solid ${C.border}`, width: '100%' } })
          return h(
            'div',
            { key, 'data-iui-divider': '1', style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%' } },
            h('span', { style: { fontSize: 11, color: C.muted, whiteSpace: 'nowrap' } }, String(props.label)),
            h('span', { style: { flex: '1 1 auto', borderTop: `1px solid ${C.border}` } }),
          )
        }
        if (item.type === 'metric') {
          const tone = TONE_COLORS[props.tone] ?? [null, C.muted]
          const value = resolve(props.value)
          const delta = resolve(props.delta)
          return h(
            'div',
            { key, 'data-iui-metric': String(props.label ?? ''), style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 0' } },
            h('div', { style: { fontSize: 11, color: C.muted } }, String(props.label ?? '')),
            h('div', { style: { fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: props.tone ? tone[1] : C.text } }, `${value === undefined || value === null ? '—' : String(value)}${resolve(props.unit) === undefined || resolve(props.unit) === null ? '' : String(resolve(props.unit))}`),
            delta !== undefined && delta !== null && String(delta) !== ''
              ? h('div', { 'data-iui-delta': String(delta), style: { fontSize: 11, color: String(delta).startsWith('-') ? '#d1242f' : '#2ea043' } }, String(delta))
              : null,
            (() => {
              const caption = resolve(props.caption ?? props.note)
              return caption === undefined || caption === null || String(caption) === '' ? null : h('div', { style: { fontSize: 10, color: C.muted } }, String(caption))
            })(),
          )
        }
        if (item.type === 'segmented') {
          const binding = IUI_AST.readBinding(props.bind)
          const current = binding.scope === 'state' ? readStatePath(state, binding.key) : undefined
          const options = Array.isArray(props.options) ? props.options : []
          const selectedIndex = options.findIndex((option) => sameValue(option?.value, current))
          return h(
            'div',
            { key, style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            props.label ? h('span', { style: { fontSize: 11, color: C.muted } }, String(props.label)) : null,
            ...options.map((option, index) =>
              h(
                'button',
                {
                  key: `${key}-${index}`,
                  type: 'button',
                  'aria-pressed': index === selectedIndex,
                  onClick: () => {
                    if (binding.scope !== 'state') return
                    setState((prev) => writeStatePath(prev, binding.key, option.value))
                  },
                  style: {
                    border: `1px solid ${index === selectedIndex ? C.brand : C.border}`,
                    background: index === selectedIndex ? C.brand : 'transparent',
                    color: index === selectedIndex ? '#fff' : C.muted,
                    borderRadius: 999,
                    padding: '2px 10px',
                    fontSize: 11,
                    cursor: 'pointer',
                  },
                },
                String(option.label ?? ''),
              ),
            ),
          )
        }
        if (item.type === 'paragraph') {
          const TONE = {
            neutral: { bg: 'rgba(127,127,127,0.14)', fg: C.text },
            success: { bg: 'rgba(46,160,67,0.16)', fg: '#2ea043' },
            warning: { bg: 'rgba(210,153,34,0.18)', fg: '#b08800' },
            danger: { bg: 'rgba(218,54,51,0.16)', fg: '#d1242f' },
            info: { bg: 'rgba(65,118,230,0.16)', fg: C.brand },
            accent: { bg: 'rgba(65,118,230,0.16)', fg: C.brand },
          }
          const ICON_GLYPH = { check: '✓', alert: '!', dot: '•', 'arrow-right': '→', spark: '✳' }
          const inline = (child, index) => {
            const key2 = `${key}-${index}`
            if (child.type === 'text') return h('span', { key: key2 }, String(child.props.text ?? ''))
            if (child.type === 'badge') {
              const tone = TONE[child.props.tone] ?? TONE.neutral
              return h('span', { key: key2, 'data-iui-badge': String(child.props.tone ?? 'neutral'), style: { display: 'inline-block', padding: '0 6px', margin: '0 2px', borderRadius: 999, fontSize: 11, lineHeight: '18px', background: tone.bg, color: tone.fg } }, String(child.props.text ?? ''))
            }
            if (child.type === 'emphasis') return h(child.props.strong === false ? 'em' : 'strong', { key: key2 }, String(child.props.text ?? ''))
            if (child.type === 'code') return h('code', { key: key2, style: { fontFamily: 'ui-monospace, monospace', fontSize: 12, background: 'rgba(127,127,127,0.14)', borderRadius: 4, padding: '0 4px' } }, String(child.props.text ?? ''))
            if (child.type === 'link') return h('a', { key: key2, href: String(child.props.href ?? ''), target: '_blank', rel: 'noreferrer noopener', style: { color: C.brand, textDecoration: 'underline' } }, String(child.props.text ?? ''))
            if (child.type === 'icon') return h('span', { key: key2, 'data-iui-icon': String(child.props.name ?? ''), role: 'img', 'aria-label': String(child.props.label ?? child.props.name ?? ''), style: { margin: '0 2px' } }, ICON_GLYPH[child.props.name] ?? '•')
            return h('span', { key: key2 }, '')
          }
          return h(
            'div',
            { key, 'data-iui-inline': String(item.children.length), style: { display: 'block', fontSize: 13, lineHeight: '22px', color: C.text, overflowWrap: 'break-word' } },
            ...item.children.map(inline),
          )
        }
        if (item.type === 'badge') {
          const tone = TONE_COLORS[props.tone] ?? TONE_COLORS.neutral
          return h('span', { key, 'data-iui-badge': String(props.tone ?? 'neutral'), style: { display: 'inline-block', padding: '0 6px', borderRadius: 999, fontSize: 11, background: tone[0], color: tone[1] } }, String(props.text ?? ''))
        }
        if (item.type === 'callout') {
          const tone = String(props.tone ?? 'neutral')
          const color = (TONE_COLORS[tone] ?? TONE_COLORS.neutral)[1]
          const kids = item.children.map((child, index) => node(child, `${key}-${index}`))
          return h(
            'div',
            { key, 'data-iui-callout': tone, style: { display: 'flex', flexDirection: 'column', gap: 6, borderLeft: `3px solid ${color}`, background: 'rgba(127,127,127,0.07)', borderRadius: 6, padding: '8px 10px' } },
            props.title ? h('div', { style: { fontSize: 12, fontWeight: 600, color } }, String(props.title)) : null,
            String(props.text ?? '') !== '' ? h('div', { style: { fontSize: 12, lineHeight: '18px', color: C.text } }, String(props.text)) : null,
            ...kids,
          )
        }
        if (item.type === 'progress') {
          const max = Number(props.max ?? 1)
          const ratio = Math.max(0, Math.min(1, Number(props.value) / (max === 0 ? 1 : max)))
          return h(
            'div',
            { key, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            props.label ? h('div', { style: { fontSize: 11, color: C.muted } }, String(props.label)) : null,
            h('div', { role: 'progressbar', 'aria-valuenow': String(Math.round(ratio * 100)), 'aria-valuemin': '0', 'aria-valuemax': '100', style: { height: 6, borderRadius: 999, background: 'rgba(127,127,127,0.18)', overflow: 'hidden' } },
              h('div', { style: { width: `${ratio * 100}%`, height: '100%', background: (TONE_COLORS[props.tone] ?? [null, C.brand])[1] } })),
          )
        }
        if (item.type === 'empty') {
          const glyph = { check: '✓', alert: '!', dot: '•', 'arrow-right': '→', spark: '✳', chart: '▤', layers: '▦', shield: '⛨', clock: '◷', inbox: '▣', info: 'ℹ' }
          return h(
            'div',
            { key, 'data-iui-empty': '1', style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, textAlign: 'center', padding: '14px 0', color: C.muted } },
            props.icon ? h('div', { style: { fontSize: 18, lineHeight: '22px' } }, glyph[props.icon] ?? '•') : null,
            props.title ? h('div', { style: { fontSize: 12, fontWeight: 600, color: C.text } }, String(props.title)) : null,
            String(props.description ?? props.text ?? '') !== ''
              ? h('div', { style: { fontSize: 11, lineHeight: '17px', maxWidth: 320 } }, String(props.description ?? props.text ?? ''))
              : null,
          )
        }
        if (item.type === 'card') {
          const kids = item.children.map((child, index) => node(child, `${key}-${index}`))
          const span = Number(props.span ?? 1)
          return h(
            'div',
            {
              key,
              'data-iui-container': 'card',
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: Number(props.gap ?? 8),
                border: `1px solid ${C.border}`,
                borderRadius: 10,
                padding: 12,
                minWidth: 0,
                gridColumn: Number.isFinite(span) && span > 1 ? `span ${Math.min(3, span)}` : undefined,
              },
            },
            props.title ? h('div', { style: { fontSize: 12, fontWeight: 600, color: C.text } }, String(props.title)) : null,
            props.subtitle ? h('div', { style: { fontSize: 10, color: C.muted } }, String(props.subtitle)) : null,
            ...kids,
          )
        }
        if (item.type === 'grid') {
          return h(
            'div',
            {
              key,
              'data-iui-container': 'grid',
              style: {
                display: 'grid',
                gridTemplateColumns: props.columns && Number(props.columns) > 1
                  ? `repeat(auto-fit, minmax(160px, 1fr))`
                  : 'repeat(auto-fit, minmax(160px, 1fr))',
                alignItems: props.align === 'stretch' ? 'stretch' : undefined,
                gap: Number(props.gap ?? 10),
              },
            },
            ...item.children.map((child, index) => node(child, `${key}-${index}`)),
          )
        }
        if (item.type === 'table') {
          const normalized = IUI_AST.tableMatrix(props)
          const columns = normalized.columns
          const rows = normalized.rows
          return h(
            'div',
            { key, 'data-iui-table': String(rows.length), 'data-iui-table-cols': String(columns.length), style: { overflowX: 'auto', maxWidth: '100%' } },
            h(
              'table',
              { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12, color: C.text } },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  ...columns.map((column, index) =>
                    h('th', { key: `h${index}`, style: { textAlign: 'left', padding: '6px 8px', borderBottom: `1px solid ${C.border}`, color: C.muted, fontWeight: 500 } }, String(column)),
                  ),
                ),
              ),
              h(
                'tbody',
                null,
                ...rows.map((row, rowIndex) =>
                  h(
                    'tr',
                    { key: `r${rowIndex}` },
                    ...columns.map((_, cellIndex) =>
                      h('td', { key: `c${cellIndex}`, style: { padding: '6px 8px', borderBottom: `1px solid ${C.border}` } }, String(Array.isArray(row) ? (row[cellIndex] ?? '') : '')),
                    ),
                  ),
                ),
              ),
            ),
            props.caption ? h('div', { style: { fontSize: 10, color: C.muted, paddingTop: 4 } }, String(props.caption)) : null,
          )
        }
        if (item.type === 'row' || item.type === 'column') {
          const isRow = item.type === 'row'
          return h(
            'div',
            {
              key,
              'data-iui-container': item.type,
              style: { display: isRow ? 'grid' : 'flex', gridTemplateColumns: isRow ? `repeat(${Math.max(1, item.children.length)}, minmax(0, 1fr))` : undefined, flexDirection: isRow ? undefined : 'column', gap: Number(props.gap ?? 10) },
            },
            ...item.children.map((child, index) => node(child, `${key}-${index}`)),
          )
        }
        if (item.type === 'chart') {
          const series = resolve(props.series)
          const rows = IUI_AST.chartMatrix(series)
          const kind = String(props.kind ?? 'bar')
          return h(
            'div',
            { key, 'data-iui-chart': kind, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            rows === null
              ? h('div', { 'data-iui-chart-empty': '1', role: 'status', style: { fontSize: 12, color: C.muted, padding: '18px 0' } }, '暂无有效图表数据')
              : renderChart([{ label: '项' }, { label: '值' }], rows, kind === 'line' ? 'line' : 'bar'),
            props.source ? h('div', { style: { fontSize: 10, color: C.muted } }, `来源：${String(props.source)}`) : null,
          )
        }
        return null
      }
      return h(
        'div',
        { 'data-iui-output': 'ok', 'data-iui-format': format ?? 'json', 'data-iui-degraded': String(degradedCount), style: { display: 'flex', flexDirection: 'column', gap: 10, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12 } },
        ast.title ? h('div', { style: { fontSize: 13, fontWeight: 600 } }, ast.title) : null,
        node(ast.root, 'root'),
      )
    }

    function readStatePath(source, path) {
      let cursor = source
      for (const part of String(path).split('.')) {
        if (cursor === null || typeof cursor !== 'object') return undefined
        cursor = cursor[part]
      }
      return cursor
    }
    function writeStatePath(source, path, value) {
      const parts = String(path).split('.')
      const clone = Array.isArray(source) ? [...source] : { ...source }
      let cursor = clone
      for (let index = 0; index < parts.length - 1; index += 1) {
        const part = parts[index]
        const child = cursor[part]
        cursor[part] = child !== null && typeof child === 'object' ? (Array.isArray(child) ? [...child] : { ...child }) : {}
        cursor = cursor[part]
      }
      cursor[parts[parts.length - 1]] = value
      return clone
    }
    function sameValue(a, b) {
      if (a === b) return true
      try {
        return JSON.stringify(a) === JSON.stringify(b)
      } catch {
        return false
      }
    }

    const TONE_COLORS = {
      neutral: ['rgba(127,127,127,0.14)', C.text],
      info: ['rgba(65,118,230,0.16)', C.brand],
      accent: ['rgba(65,118,230,0.16)', C.brand],
      success: ['rgba(46,160,67,0.16)', '#2ea043'],
      warning: ['rgba(210,153,34,0.18)', '#b08800'],
      danger: ['rgba(218,54,51,0.16)', '#d1242f'],
    }

    function renderInlinePrimitive(node) {
      const props = node?.props ?? {}
      if (node?.type === 'text') return h('span', null, String(props.text ?? ''))
      if (node?.type === 'badge') {
        const tone = TONE_COLORS[props.tone] ?? TONE_COLORS.neutral
        return h('span', { 'data-iui-badge': String(props.tone ?? 'neutral'), style: { display: 'inline-block', padding: '0 6px', borderRadius: 999, fontSize: 11, lineHeight: '18px', background: tone[0], color: tone[1] } }, String(props.text ?? ''))
      }
      if (node?.type === 'icon') return h('span', { 'data-iui-icon': String(props.name ?? ''), role: 'img', 'aria-label': String(props.label ?? props.name ?? '') }, { check: '✓', alert: '!', dot: '•', 'arrow-right': '→', spark: '✳' }[props.name] ?? '•')
      if (node?.type === 'code') return h('code', { style: { fontFamily: 'ui-monospace, monospace', fontSize: 12, background: 'rgba(127,127,127,0.14)', borderRadius: 4, padding: '0 4px' } }, String(props.text ?? ''))
      if (node?.type === 'link') return h('a', { href: String(props.href ?? ''), target: '_blank', rel: 'noreferrer noopener', style: { color: C.brand, textDecoration: 'underline' } }, String(props.text ?? ''))
      if (node?.type === 'emphasis') return h(props.strong === false ? 'em' : 'strong', null, String(props.text ?? ''))
      return h('span', null, '')
    }

    function readIuiFence(raw) {
      const text = String(raw ?? '').trim()
      if (text === '') return { ok: false, errors: ['空内容'], format: 'ml' }
      if (text.startsWith('{')) {
        let parsed = null
        try {
          parsed = JSON.parse(text)
        } catch {
          return { ok: false, errors: ['不是合法 JSON'], format: 'json' }
        }
        if (parsed === null || typeof parsed !== 'object') return { ok: false, errors: ['AST 必须是对象'], format: 'json' }
        // 历史消息：旧 ink-view 的七 Widget spec（{widget,...}）只读映射到新 AST
        if (typeof parsed.widget === 'string' && parsed.root === undefined) {
          const adopted = LEGACY_WIDGETS.adoptLegacySpec(parsed)
          if (!adopted.ok) return { ok: false, errors: adopted.errors, format: 'legacy', degraded: [], fallback: adopted.fallback }
          return { ok: true, doc: adopted.doc, format: 'legacy', degraded: [] }
        }
        return { ok: true, doc: parsed, format: 'json', degraded: [] }
      }
      const parsed = MIOPIIK_ML.parseMiopiikMl(text)
      return parsed.ok
        ? { ok: true, doc: parsed.doc, format: 'ml', degraded: parsed.degraded }
        : { ok: false, errors: parsed.errors, format: 'ml', degraded: parsed.degraded }
    }
