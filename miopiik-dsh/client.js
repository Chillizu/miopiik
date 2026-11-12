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

    // >>> miopiik:spec-rules (generated; edit miopiik-dsh/shared/spec-rules.js)
    const SPEC_RULES = (() => {
      /**
       * Extra 展示层协议规则的唯一真源（Host 与 Client 共用）。
       *
       * 为什么单独成文件：DSH 的 client 插件文件是按 module-loader 的工厂格式**原样下发**的，
       * 浏览器侧不能 `import` 宿主模块。所以这里写成「纯函数 + 常量、零依赖」的 ESM，
       * Host 直接 import；Client 由 tools/build-client-rules.mjs 把同一份代码内联进 client.js
       * （带 markers），并由 test/schema-drift.test.js 防止两边漂移。
       *
       * 协议 v2.1：{ protocol, v, widget, preset, title, props, fallback }
       * 与 v2 相比只收紧校验，不改变可接受的形状。
       */
      
      const UI_PROTOCOL = 'miopiik-ui/0.2'
      
      const WIDGET_KINDS = Object.freeze(['dataset', 'graph', 'timeline', 'text', 'choice', 'media', 'layout'])
      const WIDGET_PRESETS = Object.freeze(['card', 'plain', 'inset', 'stat'])
      const ACTION_KINDS = Object.freeze(['local', 'read', 'write', 'sensitive'])
      const MEDIA_KINDS = Object.freeze(['image', 'link'])
      const CHART_KINDS = Object.freeze(['bar', 'line', 'donut'])
      const LAYOUT_DIRECTIONS = Object.freeze(['stack', 'row', 'grid'])
      
      const LIMITS = Object.freeze({
        title: 80,
        fallback: 300,
        textField: 4000,
        rows: 200,
        columns: 12,
        nodes: 60,
        edges: 120,
        actions: 2,
        children: 6,
        depth: 2,
      })
      
      /** 本地图只允许落在会话的 charts 目录里（Host 生成的图），不接受任意绝对路径。 */
      const MEDIA_PATH_PATTERN = /\/\.dsh\/miopiik\/sessions\/[^/]+\/charts\/[^/]+\.(?:svg|png|jpe?g|webp|gif)$/iu
      
      function isAllowedMediaPath(path) {
        return typeof path === 'string' && path.length > 0 && path.length <= 1024 && MEDIA_PATH_PATTERN.test(path)
      }
      
      function isRecord(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value)
      }
      
      function isText(value) {
        return typeof value === 'string'
      }
      
      function finite(value) {
        return typeof value === 'number' && Number.isFinite(value)
      }
      
      /** 只保留协议允许的字段：多余的键一律丢弃，避免模型顺手塞样式。 */
      function pickProps(widget, props) {
        if (!isRecord(props)) return {}
        const keep = {
          dataset: ['columns', 'rows', 'chart', 'unit'],
          graph: ['nodes', 'edges'],
          timeline: ['items'],
          text: ['paragraphs', 'bullets'],
          choice: ['question', 'actions'],
          media: ['url', 'path', 'kind', 'alt', 'label'],
          layout: ['direction', 'children'],
        }[widget] ?? []
        const picked = {}
        for (const key of keep) if (props[key] !== undefined) picked[key] = props[key]
        for (const extra of ['unit', 'source', 'note']) {
          if (isText(props[extra]) && props[extra].trim() !== '') picked[extra] = props[extra].slice(0, 160)
        }
        return picked
      }
      
      function validateDataset(props, errors) {
        const columns = props.columns
        if (!Array.isArray(columns) || columns.length === 0) errors.push('dataset 需要 columns')
        else if (columns.length > LIMITS.columns) errors.push(`dataset 最多 ${LIMITS.columns} 列`)
        const rows = props.rows
        if (!Array.isArray(rows)) {
          errors.push('dataset 需要 rows')
          return
        }
        if (rows.length > LIMITS.rows) errors.push(`dataset 最多 ${LIMITS.rows} 行`)
        for (const [index, row] of rows.entries()) {
          if (!Array.isArray(row)) {
            errors.push(`dataset 第 ${index + 1} 行必须是数组`)
            continue
          }
          for (const cell of row) {
            if (isText(cell) ? cell.length > LIMITS.textField : !finite(cell) && typeof cell !== 'boolean' && cell !== null) {
              errors.push(`dataset 第 ${index + 1} 行的单元格不合法`)
              break
            }
          }
        }
        if (props.chart !== undefined) {
          const chart = props.chart === true ? 'bar' : props.chart
          if (!CHART_KINDS.includes(chart)) errors.push(`chart 只能是 ${CHART_KINDS.join('/')} 或 true`)
          for (const [index, row] of rows.entries()) {
            if (!Array.isArray(row) || row.length < 2) continue
            const value = row[1]
            if (!finite(value)) errors.push(`dataset 第 ${index + 1} 行的数值必须是有限数字`)
            else if (value < 0) errors.push(`dataset 第 ${index + 1} 行的数值不能是负数`)
            else if (value > 1e12) errors.push(`dataset 第 ${index + 1} 行的数值过大`)
          }
        }
      }
      
      function validateGraph(props, errors) {
        const nodes = props.nodes
        if (!Array.isArray(nodes) || nodes.length === 0) {
          errors.push('graph 需要 nodes')
          return
        }
        if (nodes.length > LIMITS.nodes) errors.push(`graph 最多 ${LIMITS.nodes} 个节点`)
        const ids = new Set()
        for (const [index, node] of nodes.entries()) {
          if (!isRecord(node)) {
            errors.push(`graph 第 ${index + 1} 个节点必须是对象`)
            continue
          }
          if (!isText(node.id) || node.id.trim() === '') errors.push(`graph 第 ${index + 1} 个节点需要 id`)
          else if (ids.has(node.id)) errors.push(`graph 节点 id 重复：${node.id}`)
          else ids.add(node.id)
          if (node.label !== undefined && !isText(node.label)) errors.push(`graph 第 ${index + 1} 个节点的 label 必须是字符串`)
          if (node.lane !== undefined && !isText(node.lane)) errors.push(`graph 第 ${index + 1} 个节点的 lane 必须是字符串`)
        }
        const edges = props.edges
        if (edges === undefined) return
        if (!Array.isArray(edges)) {
          errors.push('graph 的 edges 必须是数组')
          return
        }
        if (edges.length > LIMITS.edges) errors.push(`graph 最多 ${LIMITS.edges} 条边`)
        for (const [index, edge] of edges.entries()) {
          if (!isRecord(edge)) {
            errors.push(`graph 第 ${index + 1} 条边必须是对象`)
            continue
          }
          if (!isText(edge.from) || !isText(edge.to)) errors.push(`graph 第 ${index + 1} 条边需要 from/to`)
          else if (ids.size > 0 && (!ids.has(edge.from) || !ids.has(edge.to))) errors.push(`graph 第 ${index + 1} 条边引用了不存在的节点`)
          if (edge.label !== undefined && !isText(edge.label)) errors.push(`graph 第 ${index + 1} 条边的 label 必须是字符串`)
        }
      }
      
      function validateTimeline(props, errors) {
        const items = props.items
        if (!Array.isArray(items) || items.length === 0) {
          errors.push('timeline 需要 items')
          return
        }
        if (items.length > 24) errors.push('timeline 最多 24 项')
        for (const [index, item] of items.entries()) {
          if (!isRecord(item) || !isText(item.label) || item.label.trim() === '') {
            errors.push(`timeline 第 ${index + 1} 项需要 label`)
          }
        }
      }
      
      function validateChoice(props, errors) {
        if (!isText(props.question) || props.question.trim() === '') errors.push('choice 需要 question')
        const actions = props.actions
        if (!Array.isArray(actions) || actions.length === 0) {
          errors.push('choice 需要 actions')
          return
        }
        if (actions.length > LIMITS.actions) errors.push(`choice 最多 ${LIMITS.actions} 个动作`)
        for (const [index, action] of actions.entries()) {
          if (!isRecord(action) || !isText(action.label) || action.label.trim() === '') {
            errors.push(`choice 第 ${index + 1} 个动作需要 label`)
            continue
          }
          if (action.kind !== undefined && !ACTION_KINDS.includes(action.kind)) {
            errors.push(`choice 第 ${index + 1} 个动作的 kind 只能是 ${ACTION_KINDS.join('/')}`)
          }
        }
      }
      
      function validateMedia(props, errors) {
        const hasUrl = isText(props.url) && /^https?:\/\//iu.test(props.url)
        if (props.path !== undefined) {
          if (!isAllowedMediaPath(props.path)) {
            errors.push('media.path 只接受会话 charts 目录下的图片（Host 生成的图）；本地图请用 ink_chart 返回的 markdown 图')
          }
        } else if (!hasUrl) {
          errors.push('media 需要 http(s) 的 url，或 charts 目录下的 path')
        }
        if (props.kind !== undefined && !MEDIA_KINDS.includes(props.kind)) errors.push(`media.kind 只能是 ${MEDIA_KINDS.join('/')}`)
      }
      
      function validateLayout(props, errors, depth) {
        if (!LAYOUT_DIRECTIONS.includes(props.direction)) errors.push(`layout 的 direction 只能是 ${LAYOUT_DIRECTIONS.join('/')}`)
        const children = props.children
        if (!Array.isArray(children) || children.length === 0) {
          errors.push('layout 需要 children')
          return []
        }
        if (children.length > LIMITS.children) errors.push(`layout 最多 ${LIMITS.children} 个子项`)
        const normalized = []
        for (const [index, child] of children.entries()) {
          const checked = validateSpec(child, { depth: depth + 1 })
          if (!checked.ok) {
            errors.push(`layout 第 ${index + 1} 个子项不合法：${checked.errors.join('；')}`)
            continue
          }
          normalized.push(checked.spec)
        }
        return normalized
      }
      
      /**
       * 校验并规范化一份 spec。
       * @param input 模型产出的原始 spec（不可信）
       * @param options.depth 当前嵌套深度（内部用）
       * @returns {{ok:boolean, errors:string[], available?:readonly string[], spec?:object, fallbackText?:string}}
       */
      function validateSpec(input, options = {}) {
        const depth = finite(options.depth) ? options.depth : 1
        if (!isRecord(input)) return { ok: false, errors: ['spec 必须是对象'], available: WIDGET_KINDS }
        const widget = input.widget
        if (!WIDGET_KINDS.includes(widget)) {
          return { ok: false, errors: [`未知 widget: ${String(widget)}`], available: WIDGET_KINDS }
        }
        if (depth > LIMITS.depth) {
          return { ok: false, errors: [`layout 最深 ${LIMITS.depth} 层`], available: WIDGET_KINDS }
        }
        const preset = input.preset === undefined ? 'card' : input.preset
        if (!WIDGET_PRESETS.includes(preset)) {
          return { ok: false, errors: [`未知 preset: ${String(preset)}`], available: WIDGET_PRESETS }
        }
        const fallback = isText(input.fallback) ? input.fallback.trim() : ''
        if (fallback === '') return { ok: false, errors: ['fallback 必填：它是导出与降级的唯一出口'], available: WIDGET_KINDS }
        if (fallback.length > LIMITS.fallback) return { ok: false, errors: [`fallback 不超过 ${LIMITS.fallback} 字`], available: WIDGET_KINDS }
        const title = isText(input.title) ? input.title.trim() : ''
        if (title.length > LIMITS.title) return { ok: false, errors: [`title 不超过 ${LIMITS.title} 字`], available: WIDGET_KINDS }
      
        const props = pickProps(widget, input.props ?? {})
        const errors = []
        if (widget === 'dataset') validateDataset(props, errors)
        else if (widget === 'graph') validateGraph(props, errors)
        else if (widget === 'timeline') validateTimeline(props, errors)
        else if (widget === 'text') {
          const paragraphs = Array.isArray(props.paragraphs) ? props.paragraphs : null
          const bullets = Array.isArray(props.bullets) ? props.bullets : null
          if (paragraphs === null && bullets === null) errors.push('text 需要 paragraphs 或 bullets')
          for (const list of [paragraphs, bullets]) {
            if (list === null) continue
            for (const [index, item] of list.entries()) {
              if (!isText(item) || item.length > LIMITS.textField) errors.push(`text 第 ${index + 1} 条不合法`)
            }
          }
        } else if (widget === 'choice') validateChoice(props, errors)
        else if (widget === 'media') validateMedia(props, errors)
        else if (widget === 'layout') {
          const children = validateLayout(props, errors, depth)
          if (children.length > 0) props.children = children
        }
        if (errors.length > 0) return { ok: false, errors, available: WIDGET_KINDS }
        return {
          ok: true,
          errors: [],
          spec: { protocol: UI_PROTOCOL, v: 2, widget, preset, title, props, fallback },
          fallbackText: fallback,
        }
      }
      
      /** 嵌套深度。 */
      function layoutDepth(spec) {
        if (!isRecord(spec) || spec.widget !== 'layout') return 0
        const children = Array.isArray(spec.props?.children) ? spec.props.children : []
        return 1 + Math.max(0, ...children.map((child) => layoutDepth(child)))
      }
      
      /** 给导出/Markdown 用的纯文本（永远可读）。 */
      function widgetFallbackText(spec) {
        if (!isRecord(spec)) return ''
        return isText(spec.fallback) ? spec.fallback.trim() : ''
      }
      return { UI_PROTOCOL, WIDGET_KINDS, WIDGET_PRESETS, ACTION_KINDS, MEDIA_KINDS, CHART_KINDS, LAYOUT_DIRECTIONS, LIMITS, MEDIA_PATH_PATTERN, isAllowedMediaPath, validateSpec, layoutDepth, widgetFallbackText }
    })()
    // <<< miopiik:spec-rules

    // >>> miopiik:assistant-blocks (generated; edit miopiik-dsh/shared/assistant-blocks.js)
    const ASSISTANT_BLOCKS = (() => {
      /**
       * assistant 消息块 → 渲染计划（纯函数，Host/Client 共用，无 DOM 依赖）。
       *
       * 为什么单独抽出来：之前内联渲染直接在 for 循环里用 `return` 做"跳过"，
       * 结果第一个不匹配的块就退出了整个组件，普通正文整段消失（P0）。
       * 现在分类逻辑集中在这里，组件只做"映射"，不允许提前 return。
       */
      
      const ASSISTANT_BLOCK_KINDS = Object.freeze(['text', 'reasoning', 'images', 'unknown'])
      
      /**
       * @param blocks assistant 消息的 block 数组（不可信，可能含 null）
       * @param groupPart 该节点在回合里的分组：'reasoning' | 'response' | undefined
       * @returns {Array<{kind:string, text?:string, images?:Array, block?:unknown}>}
       */
      function planAssistantBlocks(blocks, groupPart) {
        const plan = []
        if (!Array.isArray(blocks)) return plan
        for (let index = 0; index < blocks.length; index += 1) {
          const block = blocks[index]
          if (block === null || typeof block !== 'object') continue
          if (groupPart === 'reasoning' && block.kind !== 'reasoning') continue
          if (groupPart === 'response' && block.kind === 'reasoning') continue
          if (block.kind === 'reasoning') {
            const text = String(block.text ?? '')
            if (text.trim() !== '') plan.push({ kind: 'reasoning', text })
            continue
          }
          if (block.kind === 'image') {
            const group = [block]
            while (index + 1 < blocks.length && blocks[index + 1]?.kind === 'image') {
              index += 1
              group.push(blocks[index])
            }
            plan.push({ kind: 'images', images: group.map((item) => ({ attachment: item.attachment })) })
            continue
          }
          if (block.kind === 'text') {
            plan.push({ kind: 'text', text: String(block.text ?? '') })
            continue
          }
          // 工具调用由 Chat 自己的工具行渲染，正文里跳过，避免重复
          if (block.kind === 'tool-call') continue
          plan.push({ kind: 'unknown', block })
        }
        return plan
      }
      return { ASSISTANT_BLOCK_KINDS, planAssistantBlocks }
    })()
    // <<< miopiik:assistant-blocks

    // >>> miopiik:ui-dsl (generated; edit miopiik-dsh/shared/ui-dsl.js)
    const UI_DSL = (() => {
      /**
       * 实验原型：面向模型的紧凑声明 DSL（P1 探索，未接入渲染路径）。
       *
       * 目标：验证「比 JSON 更省 token、且模型更好写」的假设，同时不放弃结构校验——
       * 解析产物一律交给 shared/spec-rules.js 的 validateSpec 变成标准 AST，
       * 非法就降级为纯文本，不进渲染。
       *
       * 语法（示例）：
       *   ::card title="本周预算" source="git log"
       *   chart bar
       *   本周 3
       *   下周 5
       *   ::end
       *
       *   ::text title="说明"
       *   p 第一段
       *   b 要点
       *   ::end
       */
      
      
      const OPEN = /^::([a-z]+)(?:[ \t]+(.*))?$/u
      const KV = /([a-z]+)="((?:[^"\\]|\\.)*)"/gu
      
      function readAttrs(text) {
        const attrs = {}
        for (const match of String(text ?? '').matchAll(KV)) attrs[match[1]] = match[2].replace(/\\"/gu, '"')
        return attrs
      }
      
      function parseDataset(lines, attrs) {
        const rows = []
        let chart = 'bar'
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed === '') continue
          if (trimmed.startsWith('chart ')) {
            chart = trimmed.slice(6).trim()
            continue
          }
          const parts = trimmed.split(/\s+/u)
          if (parts.length < 2) return { error: `无法解析数据行：${trimmed}` }
          const value = Number(parts[parts.length - 1])
          if (!Number.isFinite(value)) return { error: `数值不合法：${trimmed}` }
          rows.push([parts.slice(0, -1).join(' '), value])
        }
        return {
          spec: {
            widget: 'dataset',
            preset: 'card',
            title: attrs.title ?? '',
            props: { chart, columns: [{ label: '项' }, { label: '值' }], rows, ...(attrs.source ? { source: attrs.source } : {}) },
            fallback: attrs.fallback ?? defaultFallback(rows),
          },
        }
      }
      
      function parseText(lines, attrs) {
        const paragraphs = []
        const bullets = []
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed === '') continue
          if (trimmed.startsWith('b ')) bullets.push(trimmed.slice(2))
          else if (trimmed.startsWith('p ')) paragraphs.push(trimmed.slice(2))
          else paragraphs.push(trimmed)
        }
        return {
          spec: {
            widget: 'text',
            preset: 'card',
            title: attrs.title ?? '',
            props: { paragraphs, bullets },
            fallback: attrs.fallback ?? defaultFallback([...paragraphs, ...bullets].map((t) => ['', 0])),
          },
        }
      }
      
      function defaultFallback(rows) {
        return rows.map((row) => `${row[0]} ${row[1]}`).join('，').slice(0, 300) || '（无内容）'
      }
      
      /**
       * 把一段带 DSL 块的正文切成 {kind:'text'|'ui', ...} 片段；非法块降级为 text。
       * @param source 模型输出
       * @param options.measure 为 true 时附带 JSON 对照长度（仅供原型测量）
       */
      function compileInlineDsl(source, validate) {
        const lines = String(source ?? '').split(/\r?\n/u)
        const segments = []
        let buffer = []
        let index = 0
        const flush = () => {
          if (buffer.length > 0) segments.push({ kind: 'text', text: buffer.join('\n') })
          buffer = []
        }
        while (index < lines.length) {
          const open = OPEN.exec(lines[index])
          if (open === null) {
            buffer.push(lines[index])
            index += 1
            continue
          }
          const [, name, rest] = open
          const attrs = readAttrs(rest)
          const body = []
          index += 1
          let closed = false
          while (index < lines.length) {
            if (/^::end\s*$/u.test(lines[index])) {
              closed = true
              index += 1
              break
            }
            body.push(lines[index])
            index += 1
          }
          const parsed = name === 'card' || name === 'chart' ? parseDataset(body, attrs) : name === 'text' ? parseText(body, attrs) : { error: `未知块：${name}` }
          if (!closed || parsed.error !== undefined) {
            buffer.push(...lines.slice(index - body.length - 1, index))
            continue
          }
          const checked = validate(parsed.spec)
          flush()
          if (!checked.ok) {
            segments.push({ kind: 'text', text: attrs.fallback ?? `（这一段界面描述不合法：${checked.errors[0]}）` })
            continue
          }
          segments.push({ kind: 'ui', spec: checked.spec })
        }
        flush()
        return segments
      }
      
      /** 原型测量：同一份内容，DSL 与 JSON 各占多少字符（token 成本的粗代理）。 */
      function comparePayloadCost(specs) {
        const json = JSON.stringify(specs)
        const dsl = specs
          .map((spec) => {
            if (spec.widget !== 'dataset') return `::text title="${spec.title ?? ''}"\n::end`
            const rows = spec.props.rows.map((row) => `${row[0]} ${row[1]}`).join('\n')
            return `::card title="${spec.title ?? ''}" source="${spec.props.source ?? ''}"\nchart ${spec.props.chart === true ? 'bar' : spec.props.chart}\n${rows}\n::end`
          })
          .join('\n')
        return { json: json.length, dsl: dsl.length, ratio: Number((dsl.length / json.length).toFixed(2)) }
      }
      return { compileInlineDsl, comparePayloadCost }
    })()
    // <<< miopiik:ui-dsl

    // >>> miopiik:iui-ast (generated; edit miopiik-dsh/shared/iui-ast.js)
    const IUI_AST = (() => {
      /**
       * IUI AST v1（实验层）：有限的受信组件 + 任意组合 + 局部状态绑定。
       *
       * 设计边界：
       *  - 模型/示例只产出**结构**（组件树 + 属性 + 状态初值 + 声明式绑定），不产出 CSS/JS；
       *  - 组件类型必须在 REGISTRY 白名单内，未知类型→所在子树降级为 fallback 文本；
       *  - 绑定只允许 `$state.<key>` 与 `$data.<key>` 两种形式，不做表达式求值；
       *  - 预算（节点数/深度/数据量）在这里统一拒绝，由调用方决定降级策略。
       */
      
      const IUI_VERSION = 'iui/1'
      
      const REGISTRY = Object.freeze({
        text: { props: { text: 'string' }, children: false },
        metric: { props: { label: 'string', value: 'value', unit: 'string?', note: 'string?' }, children: false },
        row: { props: { gap: 'number?' }, children: true },
        column: { props: { gap: 'number?' }, children: true },
        chart: { props: { kind: 'string', series: 'value', source: 'string?' }, children: false },
        segmented: { props: { label: 'string?', options: 'value', bind: 'string' }, children: false },
        divider: { props: {}, children: false },
      })
      
      const LIMITS = Object.freeze({ nodes: 120, depth: 4, series: 60, options: 6, text: 2000 })
      
      const BIND = /^\$(state|data)\.([A-Za-z0-9_]+)$/u
      
      function isRecord(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value)
      }
      
      /** 只允许 `$state.x` / `$data.x`，其余原样返回。 */
      function readBinding(value) {
        if (typeof value !== 'string') return { literal: value }
        const match = BIND.exec(value)
        return match === null ? { literal: value } : { scope: match[1], key: match[2] }
      }
      
      /** 解析绑定到实际值（无表达式、无函数）。 */
      function resolveValue(value, scope) {
        const binding = readBinding(value)
        if (binding.scope === undefined) return binding.literal
        const source = scope[binding.scope] ?? {}
        return source[binding.key]
      }
      
      /**
       * 校验并规范化一棵 AST。
       * @returns {{ok:true, ast} | {ok:false, errors, fallback}}
       */
      function validateAst(input) {
        const errors = []
        let nodes = 0
        const walk = (node, depth, path) => {
          if (!isRecord(node)) {
            errors.push(`${path} 不是对象`)
            return null
          }
          if (depth > LIMITS.depth) {
            errors.push(`${path} 超过最大深度 ${LIMITS.depth}`)
            return null
          }
          nodes += 1
          if (nodes > LIMITS.nodes) {
            errors.push(`节点数超过 ${LIMITS.nodes}`)
            return null
          }
          const type = node.type
          const spec = REGISTRY[type]
          if (spec === undefined) {
            errors.push(`${path} 未知组件类型：${String(type)}`)
            return null
          }
          const props = isRecord(node.props) ? node.props : {}
          if (props.bind !== undefined) {
            const binding = readBinding(props.bind)
            if (binding.scope !== 'state') errors.push(`${path}.bind 只能绑定 $state.*`)
          }
          if (type === 'segmented' && (!Array.isArray(props.options) || props.options.length === 0 || props.options.length > LIMITS.options)) {
            errors.push(`${path}.options 必须是 1–${LIMITS.options} 项数组`)
          }
          if (type === 'chart') {
            const series = readBinding(props.series)
            const literal = series.literal
            if (Array.isArray(literal) && literal.length > LIMITS.series) errors.push(`${path}.series 超过 ${LIMITS.series} 点`)
          }
          if (type === 'text' && typeof props.text === 'string' && props.text.length > LIMITS.text) errors.push(`${path}.text 超过 ${LIMITS.text} 字`)
          const children = spec.children && Array.isArray(node.children) ? node.children.map((child, index) => walk(child, depth + 1, `${path}.children[${index}]`)).filter(Boolean) : []
          return { id: typeof node.id === 'string' && node.id !== '' ? node.id : path, type, props, children }
        }
        const ast = walk(input, 1, 'root')
        if (ast === null || errors.length > 0) {
          return { ok: false, errors, fallback: typeof input?.fallback === 'string' ? input.fallback : '' }
        }
        const state = isRecord(input.state) ? input.state : {}
        return { ok: true, errors: [], ast: { version: IUI_VERSION, state, root: ast, fallback: typeof input.fallback === 'string' ? input.fallback : '', title: typeof input.title === 'string' ? input.title : '' } }
      }
      
      /** 局部降级：把一棵不合法子树换成 fallback 文本节点。 */
      function degradeToText(text) {
        return { id: 'degrade', type: 'text', props: { text: String(text ?? '') }, children: [] }
      }
      return { IUI_VERSION, REGISTRY, LIMITS, readBinding, resolveValue, validateAst, degradeToText }
    })()
    // <<< miopiik:iui-ast

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
    // 正文内嵌的开关：不是配置项，而是注册/注销——关掉时 dispose，chat 自己的渲染器就回来了。
    // 正文接管默认关闭；用户开关一次后记住（localStorage），避免每次刷新重置。
    const INLINE_KEY = 'miopiik.inlineBody'
    const readInlinePref = () => {
      try {
        return localStorage.getItem(INLINE_KEY) === '1'
      } catch {
        return false
      }
    }
    const inlineBody = createStore({ enabled: readInlinePref() })
    let inlineBodyControl = { register: null, dispose: null }
    function setInlineBody(enabled) {
      try {
        localStorage.setItem(INLINE_KEY, enabled ? '1' : '0')
      } catch {
        // 存不下就只对本次生效
      }
      inlineBody.set({ enabled })
      if (enabled) {
        if (inlineBodyControl.dispose === null && inlineBodyControl.register !== null) {
          inlineBodyControl.dispose = inlineBodyControl.register()
        }
        return
      }
      if (inlineBodyControl.dispose !== null) {
        inlineBodyControl.dispose()
        inlineBodyControl.dispose = null
      }
    }

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
        ['context', t('tab.context')],
        ['view', t('tab.view')],
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
              : tab === 'context'
              ? h(ContextPane, { snapshot })
              : tab === 'view'
              ? h('div', { style: { display: 'flex', flexDirection: 'column' } }, h(WidgetCanvas, { snapshot }), h(DslPreview, {}))
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


    // ── 实验性 IUI v1：受信组件树 + 局部状态（不做表达式求值，不执行模型脚本）──
    const IUI_SAMPLES = (() => {
      const range = (label, series, current, prev) => ({ label, value: { series, current, prev } })
      return {
        interactive: {
          title: '周活跃概览',
          fallback: '近 7 天活跃 74 次，上一区间 52 次。',
          state: { range: range('近7天', [['一', 12], ['二', 18], ['三', 15], ['四', 9], ['五', 20]], 74, 52) },
          root: {
            id: 'root',
            type: 'column',
            props: { gap: 12 },
            children: [
              { id: 'note', type: 'text', props: { text: '切换时间范围只改本地状态，不会再请求模型。' } },
              {
                id: 'seg',
                type: 'segmented',
                props: {
                  label: '范围',
                  bind: '$state.range',
                  options: [
                    range('近7天', [['一', 12], ['二', 18], ['三', 15], ['四', 9], ['五', 20]], 74, 52),
                    range('近30天', [['第1周', 40], ['第2周', 61], ['第3周', 52], ['第4周', 78]], 231, 198),
                  ],
                },
              },
              {
                id: 'metrics',
                type: 'row',
                props: { gap: 12 },
                children: [
                  { id: 'm1', type: 'metric', props: { label: '当前区间', value: '$state.range.current', unit: '次' } },
                  { id: 'm2', type: 'metric', props: { label: '上一区间', value: '$state.range.prev', unit: '次' } },
                ],
              },
              { id: 'chart', type: 'chart', props: { kind: 'bar', series: '$state.range.series', source: '本地示例数据' } },
            ],
          },
        },
        compare: {
          title: '两种口径对比',
          fallback: '两种口径：主分支 12 次，含 PR 分支 18 次。',
          root: {
            id: 'root',
            type: 'row',
            props: { gap: 12 },
            children: [
              {
                id: 'left',
                type: 'column',
                props: { gap: 6 },
                children: [
                  { id: 'l1', type: 'metric', props: { label: '主分支提交', value: 12, unit: '次' } },
                  { id: 'l2', type: 'text', props: { text: '只统计 main，口径更窄。' } },
                ],
              },
              {
                id: 'right',
                type: 'column',
                props: { gap: 6 },
                children: [
                  { id: 'r1', type: 'metric', props: { label: '含 PR 分支', value: 18, unit: '次' } },
                  { id: 'r2', type: 'text', props: { text: '包含 feature 分支，口径更宽。' } },
                ],
              },
            ],
          },
        },
        broken: {
          title: '坏 AST',
          fallback: '这段界面描述不合法，已降级为文本。',
          root: {
            id: 'root',
            type: 'column',
            props: { gap: 8 },
            children: [
              { id: 'ok', type: 'text', props: { text: '这一段本来合法，但兄弟节点坏了。' } },
              { id: 'bad', type: 'qrcode', props: {} },
            ],
          },
        },
      }
    })()

    function IuiSheet({ sample }) {
      const checked = IUI_AST.validateAst(sample)
      const [state, setState] = React.useState(checked.ok ? checked.ast.state : {})
      React.useEffect(() => {
        if (checked.ok) setState(checked.ast.state)
      }, [sample])
      if (!checked.ok) {
        return h(
          'div',
          { 'data-iui-output': 'invalid', style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, lineHeight: '18px' } },
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
        if (item.type === 'divider') return h('hr', { key, style: { border: 'none', borderTop: `1px solid ${C.border}`, width: '100%' } })
        if (item.type === 'metric') {
          return h(
            'div',
            { key, 'data-iui-metric': String(props.label ?? ''), style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 0' } },
            h('div', { style: { fontSize: 11, color: C.muted } }, String(props.label ?? '')),
            h('div', { style: { fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums' } }, `${String(resolve(props.value) ?? '—')}${props.unit ? String(props.unit) : ''}`),
            props.note ? h('div', { style: { fontSize: 10, color: C.muted } }, String(props.note)) : null,
          )
        }
        if (item.type === 'segmented') {
          const binding = IUI_AST.readBinding(props.bind)
          const current = binding.scope === 'state' ? state[binding.key] : undefined
          const options = Array.isArray(props.options) ? props.options : []
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
                  'aria-pressed': current === option.value,
                  onClick: () => {
                    if (binding.scope !== 'state') return
                    setState((prev) => ({ ...prev, [binding.key]: option.value }))
                  },
                  style: {
                    border: `1px solid ${current === option.value ? C.brand : C.border}`,
                    background: current === option.value ? C.brand : 'transparent',
                    color: current === option.value ? '#fff' : C.muted,
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
          const rows = Array.isArray(series) ? series.map((point) => (Array.isArray(point) ? point : [String(point?.label ?? ''), Number(point?.value ?? 0)])) : []
          const kind = String(props.kind ?? 'bar')
          return h(
            'div',
            { key, 'data-iui-chart': kind, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            renderChart([{ label: '项' }, { label: '值' }], rows, kind === 'line' ? 'line' : 'bar'),
            props.source ? h('div', { style: { fontSize: 10, color: C.muted } }, `来源：${String(props.source)}`) : null,
          )
        }
        return null
      }
      return h(
        'div',
        { 'data-iui-output': 'ok', style: { display: 'flex', flexDirection: 'column', gap: 10, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12 } },
        ast.title ? h('div', { style: { fontSize: 13, fontWeight: 600 } }, ast.title) : null,
        node(ast.root, 'root'),
      )
    }

    function IuiPreview({ sample, onSample }) {
      const buttons = [
        ['interactive', t('iui.sampleInteractive')],
        ['compare', t('iui.sampleCompare')],
        ['broken', t('iui.sampleBroken')],
      ]
      return h(
        'div',
        { 'data-iui-preview': '1', style: { display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16, borderTop: `1px dashed ${C.border}`, paddingTop: 14 } },
        h('div', { style: { fontSize: 13, fontWeight: 600 } }, t('iui.title')),
        h('div', { style: { fontSize: 11, color: C.muted, lineHeight: '16px' } }, t('iui.hint')),
        h(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          ...buttons.map(([key, label]) => h('button', { key, type: 'button', onClick: () => onSample(key), style: styles.action }, label)),
        ),
        h(IuiSheet, { sample: IUI_SAMPLES[sample] }),
      )
    }

    // 实验性 IUI：紧凑 DSL 预览（默认关闭，只在「视图」页跑，不碰 assistant-step）
    const DSL_PREVIEW_KEY = 'miopiik.dslPreview'
    const DSL_SAMPLE_CHART = `先看这周的数据。

::card title="每周提交" source="git log"
chart bar
周一 12
周二 18
周三 15
::end

上面这张是构建活动，下面是说明文字。`
    const DSL_SAMPLE_COMPARE = `两种口径放一起看：

::card title="按周统计" source="git log"
chart bar
本周 12
上周 9
::end

::text title="口径"
p 数据来自 git log --date=short。
b 只统计主分支。
::end`
    const DSL_SAMPLE_BROKEN = `下面这段是坏样例：

::card title="坏样例"
chart bar
周一 abc
::end

上面这条应当降级为纯文本而不是报错。`

    function readDslPreview() {
      try {
        return localStorage.getItem(DSL_PREVIEW_KEY) === '1'
      } catch {
        return false
      }
    }

    function DslPreview() {
      const [on, setOn] = React.useState(readDslPreview)
      const [text, setText] = React.useState(DSL_SAMPLE_CHART)
      const [segments, setSegments] = React.useState(null)
      const [iuiSample, setIuiSample] = React.useState('interactive')
      const toggle = () => {
        const next = !on
        try {
          localStorage.setItem(DSL_PREVIEW_KEY, next ? '1' : '0')
        } catch {
          // 存不下就只对本次生效
        }
        setOn(next)
        setSegments(null)
      }
      const compile = (source) => {
        setText(source)
        setSegments(UI_DSL.compileInlineDsl(source, SPEC_RULES.validateSpec))
      }
      const MarkdownText = primitives !== null && primitives.MarkdownText != null ? primitives.MarkdownText : null
      return h(
        'div',
        { 'data-dsl-preview': on ? 'on' : 'off', style: { display: 'flex', flexDirection: 'column', gap: 10, marginTop: 20, borderTop: `1px dashed ${C.border}`, paddingTop: 14 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, t('dsl.title')),
          h(
            'button',
            {
              type: 'button',
              onClick: toggle,
              style: { border: `1px solid ${on ? C.brand : C.border}`, background: on ? C.brand : 'transparent', color: on ? '#fff' : C.muted, borderRadius: 999, padding: '3px 12px', fontSize: 11, cursor: 'pointer' },
            },
            on ? t('dsl.on') : t('dsl.off'),
          ),
        ),
        on
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              h('div', { style: { fontSize: 11, color: C.muted, lineHeight: '16px' } }, t('dsl.hint')),
              h('textarea', {
                value: text,
                onChange: (event) => setText(event.target.value),
                rows: 8,
                style: { width: '100%', boxSizing: 'border-box', fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: '18px', border: `1px solid ${C.border}`, borderRadius: 8, padding: 8, background: C.base, color: C.text },
              }),
              h(
                'div',
                { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                h('button', { type: 'button', onClick: () => compile(text), style: styles.action }, t('dsl.compile')),
                h('button', { type: 'button', onClick: () => compile(DSL_SAMPLE_CHART), style: styles.action }, t('dsl.sampleChart')),
                h('button', { type: 'button', onClick: () => compile(DSL_SAMPLE_COMPARE), style: styles.action }, t('dsl.sampleCompare')),
                h('button', { type: 'button', onClick: () => compile(DSL_SAMPLE_BROKEN), style: styles.action }, t('dsl.sampleBroken')),
              ),
              h(
                'div',
                { 'data-dsl-output': '1', style: { display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 4 } },
                ...(segments === null
                  ? []
                  : segments.map((segment, index) =>
                      segment.kind === 'ui'
                        ? h(WidgetCard, { key: `d${index}`, spec: segment.spec })
                        : h(
                            'div',
                            { key: `d${index}`, style: { fontSize: 12, color: segment.kind === 'text' ? C.text : C.muted, lineHeight: '18px', whiteSpace: 'pre-wrap' } },
                            MarkdownText !== null && segment.kind === 'text'
                              ? h(MarkdownText, { text: segment.text, streaming: false })
                              : segment.text,
                          ),
                    )),
              ),
              h(IuiPreview, { sample: iuiSample, onSample: setIuiSample }),
            )
          : null,
      )
    }

    function WidgetCanvas({ snapshot }) {
      const widgets = snapshot?.view?.widgets ?? []
      const card = (spec, key) => h('div', { key }, h(WidgetCard, { spec, padded: true }))
      if (widgets.length === 0) return h('div', { style: styles.empty }, t('view.empty'))
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 780, padding: '4px 2px 24px' } },
        ...widgets.map((spec, index) => card(spec, `w-${index}`)),
      )
    }

    // SVG 画布：viewBox 固定、宽度自适应；文字按 viewBox 里的坐标排，缩放时整体等比。
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

    function svgArrow(color) {
      return h(
        'defs',
        { key: 'miopiik-arrow-def' },
        h(
          'marker',
          { id: 'miopiik-arrow', markerWidth: 7, markerHeight: 7, refX: 6, refY: 3.5, orient: 'auto', markerUnits: 'userSpaceOnUse' },
          h('path', { d: 'M0,0 L7,3.5 L0,7 Z', fill: color }),
        ),
      )
    }

    const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'

    // graph：按 lane 分列排节点，边画成曲线——不是列一张边表。
    function renderGraph(nodes, edges) {
      const nodeW = 116
      const nodeH = 32
      const colGap = 88
      const rowGap = 14
      const headH = 18
      const pad = 4
      const lanes = []
      for (const node of nodes) {
        const lane = String(node.lane ?? '')
        if (!lanes.includes(lane)) lanes.push(lane)
      }
      const laneRows = lanes.map((lane) => nodes.filter((node) => String(node.lane ?? '') === lane))
      const maxRows = Math.max(1, ...laneRows.map((rows) => rows.length))
      const width = pad * 2 + lanes.length * nodeW + Math.max(0, lanes.length - 1) * colGap
      const routesBelow = edges.some((edge) => {
        const from = nodes.findIndex((node) => String(node.id ?? node.label ?? '') === String(edge.from))
        const to = nodes.findIndex((node) => String(node.id ?? node.label ?? '') === String(edge.to))
        return from >= 0 && to >= 0 && lanes.indexOf(String(nodes[to].lane ?? '')) < lanes.indexOf(String(nodes[from].lane ?? ''))
      })
      const height = pad * 2 + headH + maxRows * nodeH + Math.max(0, maxRows - 1) * rowGap + (routesBelow ? 38 : 0)
      const position = new Map()
      lanes.forEach((lane, laneIndex) => {
        const rows = laneRows[laneIndex]
        const offset = ((maxRows - rows.length) * (nodeH + rowGap)) / 2
        rows.forEach((node, rowIndex) => {
          position.set(String(node.id ?? node.label ?? `${laneIndex}:${rowIndex}`), {
            x: pad + laneIndex * (nodeW + colGap),
            y: pad + headH + offset + rowIndex * (nodeH + rowGap),
            laneIndex,
          })
        })
      })
      const parts = [svgArrow(C.link)]
      lanes.forEach((lane, laneIndex) => {
        if (lane === '') return
        parts.push(
          h(
            'text',
            { key: `lane-${laneIndex}`, x: pad + laneIndex * (nodeW + colGap), y: pad + 10, fontSize: 9, fill: C.muted, fontFamily: SANS, letterSpacing: 0.4 },
            lane,
          ),
        )
      })
      edges.forEach((edge, index) => {
        const from = position.get(String(edge.from))
        const to = position.get(String(edge.to))
        if (from === undefined || to === undefined) return
        let d = ''
        if (from.laneIndex === to.laneIndex) {
          const cx = from.x + nodeW / 2
          const down = to.y > from.y
          const y1 = down ? from.y + nodeH : from.y
          const y2 = down ? to.y : to.y + nodeH
          if (Math.abs(y2 - y1) < 2) return
          d = `M${cx},${y1} L${cx},${y2}`
        } else if (to.laneIndex > from.laneIndex) {
          const x1 = from.x + nodeW
          const x2 = to.x
          const y1 = from.y + nodeH / 2
          const y2 = to.y + nodeH / 2
          const bend = Math.max(18, Math.abs(x2 - x1) * 0.45)
          d = `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`
        } else {
          // 回边从盒子底部的偏侧进出，免得和同列的竖直边叠成双箭头
          const offset = Math.round(nodeW * 0.26)
          const x1 = from.x + nodeW / 2 + offset
          const x2 = to.x + nodeW / 2 + offset
          const y1 = from.y + nodeH
          const y2 = to.y + nodeH
          const laneBottom = pad + headH + maxRows * nodeH + Math.max(0, maxRows - 1) * rowGap
          const dip = laneBottom + 16
          d = `M${x1},${y1} C${x1},${dip} ${x2},${dip} ${x2},${y2}`
        }
        parts.push(h('path', { key: `edge-${index}`, d, fill: 'none', stroke: C.link, strokeWidth: 1.2, markerEnd: 'url(#miopiik-arrow)' }))
      })
      nodes.forEach((node, index) => {
        const spot = position.get(String(node.id ?? node.label ?? ''))
        if (spot === undefined) return
        parts.push(
          h('rect', { key: `node-${index}`, x: spot.x, y: spot.y, width: nodeW, height: nodeH, rx: 7, fill: C.base, stroke: C.borderStrong, strokeWidth: 1 }),
        )
        parts.push(
          h(
            'text',
            { key: `node-label-${index}`, x: spot.x + nodeW / 2, y: spot.y + nodeH / 2 + 3.5, fontSize: 10.5, fill: C.text, fontFamily: SANS, textAnchor: 'middle' },
            String(node.label ?? node.id ?? ''),
          ),
        )
      })
      const named = edges.filter((edge) => typeof edge.label === 'string' && edge.label !== '')
      const diagram = svgCanvas(width, height, parts)
      if (named.length === 0) return diagram
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8, width: '100%' } },
        diagram,
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: '2px 14px', fontSize: 10, color: C.muted, paddingTop: 2 } },
          ...named.map((edge, index) =>
            h('span', { key: `legend-${index}` }, `${edge.from} → ${edge.to}　${edge.label}`),
          ),
        ),
      )
    }

    // dataset.chart：bar / line / donut 三种真图表，都带刻度与数值。
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

    function renderWidget(spec) {
      const props = spec?.props ?? {}
      const muted = { fontSize: 11, color: C.muted }
      if (spec.widget === 'dataset') {
        const columns = props.columns ?? []
        const rows = props.rows ?? []
        if (props.chart !== undefined) {
          const kind = props.chart === true ? 'bar' : String(props.chart)
          return renderChart(columns, rows, kind)
        }
        return h(
          'table',
          { style: { borderCollapse: 'collapse', fontSize: 12, width: '100%', tableLayout: 'fixed' } },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              ...columns.map((column, index) =>
                h(
                  'th',
                  { key: index, style: { textAlign: 'left', padding: '5px 8px', color: C.muted, fontWeight: 500, borderBottom: `1px solid ${C.border}`, width: index === 0 ? '38%' : undefined } },
                  String(column.label ?? column),
                ),
              ),
            ),
          ),
          h(
            'tbody',
            {},
            ...rows.map((row, rowIndex) =>
              h(
                'tr',
                { key: rowIndex },
                ...row.map((cell, cellIndex) =>
                  h(
                    'td',
                    { key: cellIndex, style: { padding: '5px 8px', borderBottom: `1px solid ${C.border}`, overflowWrap: 'anywhere', verticalAlign: 'top' } },
                    String(cell ?? ''),
                  ),
                ),
              ),
            ),
          ),
        )
      }
      if (spec.widget === 'graph') {
        return renderGraph(props.nodes ?? [], props.edges ?? [])
      }
      if (spec.widget === 'timeline') {
        const items = props.items ?? []
        return h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: '54px 14px minmax(0, 1fr)', rowGap: 2, columnGap: 0, fontSize: 12 } },
          ...items.flatMap((item, index) => [
            h(
              'div',
              { key: `t${index}`, style: { ...muted, textAlign: 'right', padding: '6px 8px 6px 0', lineHeight: '16px' } },
              String(item.at ?? ''),
            ),
            h(
              'div',
              { key: `r${index}`, style: { position: 'relative', display: 'flex', justifyContent: 'center' } },
              h('div', {
                style: {
                  position: 'absolute',
                  top: index === 0 ? 14 : 0,
                  bottom: index === items.length - 1 ? 'calc(100% - 14px)' : 0,
                  width: 1.5,
                  background: C.borderStrong,
                },
              }),
              h('div', { style: { position: 'relative', marginTop: 13, width: 7, height: 7, borderRadius: '50%', background: index === items.length - 1 ? C.brand : C.muted } }),
            ),
            h(
              'div',
              { key: `c${index}`, style: { padding: '4px 0 10px 10px', minWidth: 0 } },
              h('div', { style: { color: C.text, lineHeight: '17px' } }, String(item.label ?? '')),
              item.detail ? h('div', { style: { ...muted, lineHeight: '16px', marginTop: 1 } }, String(item.detail)) : null,
            ),
          ]),
        )
      }
      if (spec.widget === 'text') {
        const paragraphs = props.paragraphs ?? []
        const bullets = props.bullets ?? []
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12, lineHeight: 1.65, color: C.text } },
          ...paragraphs.map((text, index) => h('div', { key: `p${index}` }, String(text))),
          bullets.length === 0
            ? null
            : h(
                'ul',
                { style: { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 3 } },
                ...bullets.map((text, index) => h('li', { key: `b${index}`, style: { lineHeight: 1.55 } }, String(text))),
              ),
        )
      }
      if (spec.widget === 'choice') {
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 } },
          h('div', { style: { color: C.text, lineHeight: '18px' } }, String(props.question ?? '')),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            ...(props.actions ?? []).map((action, index) =>
              h(
                'div',
                {
                  key: index,
                  style: {
                    border: `1px solid ${C.borderStrong}`,
                    borderRadius: 8,
                    padding: '8px 10px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                    background: C.base,
                  },
                },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 6, color: C.text, fontWeight: 600 } },
                  h('span', null, String(action.label ?? '')),
                  action.kind !== undefined && action.kind !== 'local'
                    ? h(
                        'span',
                        {
                          style: {
                            fontSize: 10,
                            fontWeight: 500,
                            color: action.kind === 'sensitive' ? C.error : C.muted,
                            border: `1px solid ${action.kind === 'sensitive' ? C.error : C.border}`,
                            borderRadius: 4,
                            padding: '0 4px',
                          },
                        },
                        action.kind === 'sensitive' ? '需确认' : '需授权',
                      )
                    : null,
                ),
                action.description ? h('div', { style: { ...muted, lineHeight: '16px' } }, String(action.description)) : null,
              ),
            ),
          ),
          h('div', { style: { ...muted, lineHeight: '16px' } }, '选择在对话里说，这里不代劳。'),
        )
      }
      if (spec.widget === 'media') {
        // 本地文件走 api/file（带会话鉴权），与 markdown 里的本地图同一套地址
        const raw = String(props.url ?? props.path ?? '')
        const url = typeof props.path === 'string' && props.path !== '' && typeof props.url !== 'string'
          ? new URL(`api/file?path=${encodeURIComponent(props.path)}`, document.baseURI).href
          : raw
        if (props.kind === 'image' || typeof props.path === 'string') {
          return h('img', {
            src: url,
            alt: props.alt ?? '',
            style: { maxWidth: '100%', maxHeight: 340, borderRadius: 8, display: 'block', border: `1px solid ${C.border}` },
          })
        }
        return h(
          'a',
          { href: url, target: '_blank', rel: 'noreferrer', style: { fontSize: 12, color: C.brand, textDecoration: 'none', overflowWrap: 'anywhere' } },
          String(props.label ?? url),
        )
      }
      if (spec.widget === 'layout') {
        const direction = props.direction ?? 'stack'
        const children = props.children ?? []
        const columns = direction === 'row' ? Math.max(1, children.length) : 0
        return h(
          'div',
          {
            style:
              direction === 'row'
                ? { display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 14, alignItems: 'start' }
                : direction === 'grid'
                  ? { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, alignItems: 'start' }
                  : { display: 'flex', flexDirection: 'column', gap: 14 },
          },
          ...children.map((child, index) =>
            h(
              'div',
              { key: index, style: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 } },
              child.title ? h('div', { style: { fontSize: 11, fontWeight: 600, color: C.muted, letterSpacing: 0.2 } }, child.title) : null,
              renderWidget(child),
            ),
          ),
        )
      }
      return null
    }

    // 一张卡：标题 + 投影 + 卡底 fallback。对话流节点与「视图」页共用同一套渲染。
    // 预设样式：模型只能选名字。card=带框卡片；plain=无框；inset=浅底无边框；stat=大数字行。
    function cardShell(preset, padded) {
      if (preset === 'plain') return { border: 'none', background: 'transparent', padding: 0, borderRadius: 0 }
      if (preset === 'inset') return { border: 'none', background: C.layer1, padding: padded ? '12px 14px' : '10px 12px', borderRadius: 10 }
      return {
        border: `1px solid ${C.border}`,
        background: C.layer1,
        padding: padded ? '14px 16px' : '12px 14px',
        borderRadius: 12,
      }
    }

    function WidgetCard({ spec, padded }) {
      // 渲染器隔离：一个块画不出来，只降级这一块，不许把整条消息带崩
      let body = null
      let crash = null
      try {
        body = renderWidget(spec)
      } catch (error) {
        crash = error
        body = null
      }
      const failed = body === null
      return h(
        'div',
        {
          role: 'group',
          'aria-label': typeof spec.title === 'string' && spec.title !== '' ? spec.title : spec.fallback,
          style: {
            ...cardShell(spec.preset, padded),
            margin: padded ? 0 : '4px 0',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            width: '100%',
            maxWidth: 760,
            boxSizing: 'border-box',
          },
        },
        spec.title ? h('div', { style: { fontSize: 13, fontWeight: 600, lineHeight: '18px' } }, spec.title) : null,
        failed
          ? h('div', { style: { fontSize: 12, color: C.text, whiteSpace: 'pre-wrap', lineHeight: '18px' } }, String(spec.fallback ?? ''))
          : body,
        // fallback 是降级出口，不是常驻说明：只有渲染不出来时才顶上
        failed && spec.preset === 'card'
          ? h('div', { style: { fontSize: 10, color: C.muted, borderTop: `1px dashed ${C.border}`, paddingTop: 6 } }, `降级：这份 spec 的 ${String(spec.widget)} 没能渲染`)
          : null,
        // 数据出处与备注：手册要求「图表有单位和来源」，不能把演示数据当实时
        spec.props?.source || spec.props?.note
          ? h(
              'div',
              { style: { fontSize: 10, color: C.muted, lineHeight: '15px', borderTop: `1px dashed ${C.border}`, paddingTop: 6 } },
              spec.props?.source ? h('span', null, `来源：${String(spec.props.source)}　`) : null,
              spec.props?.note ? h('span', null, String(spec.props.note)) : null,
            )
          : null,
      )
    }

    // 对话流里的卡片节点：由 ink_view 的 tool/call 事件长出一行，站到正文里。
    // 站在 Turn 这一层（groupTree: 'turn'）：与工具行同一次调用，但不进可折叠的「过程」组。
    const WIDGET_NODE_KIND = 'miopiik-widget'
    // 哪些 callId 属于 ink_view：只用来把 tool/result 的成败归回同一张卡
    const INK_VIEW_CALLS = new Set()

    function readInkViewSpec(event) {
      if (event?.type !== 'tool/call') return null
      const data = event.data ?? {}
      if (data.name !== 'ink_view') return null
      let parsed = null
      try {
        parsed = JSON.parse(data.arguments)
      } catch {
        return null
      }
      if (parsed === null || typeof parsed !== 'object' || parsed.action !== 'show' || parsed.spec === undefined) return null
      const checked = SPEC_RULES.validateSpec(parsed.spec)
      return { id: String(data.callId), spec: checked.ok ? checked.spec : null, errors: checked.ok ? [] : checked.errors }
    }

    // 一轮只留最后一张：同一 turn 的多次 ink_view 合成一个节点，后者覆盖前者；
    // 早先那些留在「视图」页快照里，节点上只记个数，不把正文堆成一堵墙。
    const widgetNodeDefinition = {
      kind: WIDGET_NODE_KIND,
      target: 'chat',
      match: (event) => {
        if (event?.type === 'tool/result') {
          const callId = event?.data?.message?.source?.callId
          if (callId === undefined || !INK_VIEW_CALLS.has(String(callId))) return null
          const turn = event?.data?.turn
          return turn === undefined || turn === null ? null : { id: `turn-${turn}`, role: 'update' }
        }
        const hit = readInkViewSpec(event)
        if (hit === null) return null
        INK_VIEW_CALLS.add(hit.id)
        const turn = event?.data?.turn
        const id = turn === undefined || turn === null ? hit.id : `turn-${turn}`
        return { id, role: 'start' }
      },
      start: (_context, match) => {
        const hit = readInkViewSpec(match.event)
        if (hit === null) throw new Error('miopiik-widget start requires an ink_view tool/call')
        return { seq: match.event.seq, specs: hit.spec === null ? [] : [hit.spec], failed: false }
      },
      update: (context, match) => {
        const state = context.state
        if (match.event?.type === 'tool/result') {
          const failed = match.event?.data?.error !== undefined || match.event?.data?.message?.isError === true
          return failed ? { ...state, seq: match.event.seq, failed: true } : state
        }
        const hit = readInkViewSpec(match.event)
        if (hit === null || hit.spec === null) return state
        return { seq: match.event.seq, specs: [...state.specs, hit.spec], failed: state.failed }
      },
      buildViewNode: (context) => {
        // 永远不返回 null：引擎不允许撤回已 materialize 的 key，只能 hidden。
        const specs = context.state?.specs ?? []
        const spec = specs[specs.length - 1] ?? null
        const failed = context.state?.failed === true
        // 引擎契约：已 materialize 的 key 不能"撤回"（return null 会抛错并打断事件流）；
        // 想不显示只能返回同一个 key 且 visibility:'hidden'。
        // 失败只影响「这一次」：本轮只要有过合法 spec 就显示最后一张，失败不回滚已成立的视图
        const hidden = spec === null
        return {
          key: context.key,
          kind: WIDGET_NODE_KIND,
          id: context.id,
          target: 'chat',
          anchorSeq: (context.state?.seq ?? 0) + 0.2,
          location: context.start?.location ?? { kind: 'unresolved' },
          visibility: hidden ? 'hidden' : 'visible',
          groupTree: 'turn',
          data: { spec, total: specs.length, failed },
        }
      },
    }

    function WidgetNodeView(props) {
      const data = props?.node?.data ?? {}
      const spec = data.spec
      if (spec === null || typeof spec !== 'object') return null
      const extra = Number.isFinite(data.total) && data.total > 1 ? data.total - 1 : 0
      return h(
        'div',
        { style: { padding: '2px 0' } },
        h(WidgetCard, { spec }),
        extra > 0
          ? h('div', { style: { fontSize: 11, color: C.muted, paddingLeft: 2 } }, `这一轮另有 ${extra} 条在「视图」页`)
          : null,
      )
    }

    function ContextPane({ snapshot }) {
      const context = snapshot?.inkContext
      const candidates = snapshot?.candidates ?? []
      if (context === undefined) return h('div', { style: styles.empty }, t('ctx.offline'))
      const head = context.head ?? ''
      const tail = context.tail ?? []
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 18, padding: '4px 2px 24px', maxWidth: 780 } },
        h(
          Section,
          { title: `${t('ctx.head')}（${context.headChars ?? 0} 字，仅保留最近 ${context.headMax ?? 2000} 字）` },
          head === ''
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
                head,
              ),
        ),
        h(
          Section,
          { title: `${t('ctx.tail')}（${context.tailCount ?? 0} 条）` },
          tail.length === 0
            ? h('div', { style: styles.empty }, t('ctx.empty'))
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                ...tail.map((entry, index) =>
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
    }

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

    // 正文内嵌：接管 assistant-step 这一行的渲染器（keyed 席位，同 key 即替换），
    // 把正文里 ```ink-view {spec}``` 的代码块换成卡片，代码块本身不再显示。
    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = null
    }

    const INK_FENCE = /```ink-view[ \t]*\r?\n([\s\S]*?)```/g

    // 正文壳：只用 DSH 的公开 theme token（--dsh-content-* / --dsw-alias-*），
    // 不再探测编译生成的 CSS 类哈希——那会随 DSH 构建漂移。
    function inlineShellStyles() {
      return {
        display: 'flex',
        flexDirection: 'column',
        fontSize: 'var(--dsh-content-font-size, 14px)',
        lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))',
        color: 'var(--dsw-alias-label-primary, #1b1b1b)',
      }
    }


    // 正文里的 spec 与工具参数走**同一套**规则（由 shared/spec-rules.js 生成内联，防漂移）。
    function readSpec(raw) {
      let parsed
      try {
        parsed = JSON.parse(String(raw).trim())
      } catch {
        return null
      }
      const checked = SPEC_RULES.validateSpec(parsed)
      if (!checked.ok) {
        const fallback = parsed !== null && typeof parsed === 'object' && typeof parsed.fallback === 'string' ? parsed.fallback.trim() : ''
        return { spec: null, fallback, errors: checked.errors }
      }
      return { spec: checked.spec, fallback: checked.fallbackText, errors: [] }
    }

    // 一段正文切成「markdown 段 / 卡片段」，保序。
    function splitInkFences(text) {
      const source = String(text ?? '')
      const parts = []
      let last = 0
      INK_FENCE.lastIndex = 0
      let match = INK_FENCE.exec(source)
      while (match !== null) {
        const hit = readSpec(match[1])
        if (hit === null) {
          match = INK_FENCE.exec(source)
          continue
        }
        if (match.index > last) parts.push({ type: 'md', text: source.slice(last, match.index) })
        if (hit.spec !== null) parts.push({ type: 'widget', spec: hit.spec })
        else if (hit.fallback !== '') parts.push({ type: 'invalid', text: hit.fallback, reason: hit.errors[0] ?? 'spec 不合法' })
        last = match.index + match[0].length
        match = INK_FENCE.exec(source)
      }
      if (last < source.length) parts.push({ type: 'md', text: source.slice(last) })
      return parts.length === 0 ? [{ type: 'md', text: source }] : parts
    }

    function InlineBodyRow(props) {
      const data = props?.node?.data ?? {}
      const blocks = data.blocks ?? []
      const groupPart = props?.groupPart
      const streaming = data.status === 'running'
      // memo/forwardRef 组件是对象不是函数，这里只判空；否则会退化成纯文本（** 与链接都不渲染）
      const MarkdownText = primitives !== null && primitives.MarkdownText != null ? primitives.MarkdownText : null
      const tr = typeof props?.t === 'function' ? props.t : (key) => key
      // 本地图（含 ink_chart 画出来的 SVG）走 api/file 鉴权路由；与 chat 的 pathImages 同一套
      const pathImages = {
        resolve: (value) => {
          try {
            const path = decodeURIComponent(String(value).split(/[?#]/u)[0] ?? '')
            if (!path.startsWith('/')) return undefined
            return new URL(`api/file?path=${encodeURIComponent(path)}`, document.baseURI).href
          } catch {
            return undefined
          }
        },
      }
      const labels = {
        code: {
          copyLabel: tr('copy'),
          copiedLabel: tr('copied'),
          toolbarLabels: { codeLabel: tr('codeBlock.title'), wrapLabel: tr('codeBlock.wrap'), unwrapLabel: tr('codeBlock.unwrap') },
        },
        footnotes: tr('markdown.footnotes'),
      }
      // 分类交给纯函数；组件只做映射，绝不提前 return（P0：曾因循环里 return 吞掉整段正文）
      const plan = ASSISTANT_BLOCKS.planAssistantBlocks(blocks, groupPart)
      const rendered = []
      plan.forEach((item, index) => {
        if (item.kind === 'reasoning') {
          rendered.push(
            h(
              'div',
              { key: `r${index}`, style: { fontSize: 12, lineHeight: '18px', color: C.muted, whiteSpace: 'pre-wrap', borderLeft: `2px solid ${C.border}`, paddingLeft: 8 } },
              item.text,
            ),
          )
          return
        }
        if (item.kind === 'images') {
          if (typeof props?.renderSlot === 'function') {
            rendered.push(
              h(
                'div',
                { key: `i${index}` },
                props.renderSlot('conversation.chat.message.images', { images: item.images, loadImage: props.loadImage, align: 'start' }),
              ),
            )
          }
          return
        }
        if (item.kind !== 'text') return
        const parts = splitInkFences(item.text)
        rendered.push(
          h(
            'div',
            { key: `t${index}`, style: { display: 'flex', flexDirection: 'column', gap: 10 } },
            ...parts.map((part, partIndex) =>
              part.type === 'widget'
                ? h(WidgetCard, { key: `w${partIndex}`, spec: part.spec })
                : part.type === 'invalid'
                  ? h('div', { key: `x${partIndex}`, style: { fontSize: 12, color: C.muted, borderLeft: `2px solid ${C.border}`, paddingLeft: 8, lineHeight: '18px' } }, part.text)
                  : MarkdownText !== null
                    ? h(MarkdownText, { key: `m${partIndex}`, text: part.text, streaming, labels, pathImages })
                    : h('div', { key: `m${partIndex}`, style: { whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.7 } }, part.text),
            ),
          ),
        )
      })
      if (data.status === 'interrupted') {
        rendered.push(
          h('div', { key: 'stopped', style: { fontSize: 12, color: C.muted, lineHeight: '18px' } }, tr('message.stopped')),
        )
      }
      if (rendered.length === 0) return null
      return h(
        'div',
        { style: inlineShellStyles() },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } }, ...rendered),
      )
    }

    function InlineBodySwitch() {
      const { enabled } = useStore(inlineBody)
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            border: `1px solid ${C.border}`,
            borderRadius: 10,
            padding: '10px 12px',
            fontSize: 12,
          },
        },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
          h('span', null, t('settings.inlineBody')),
          h('span', { style: { fontSize: 11, color: C.muted } }, t('settings.inlineBodyHint')),
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: () => setInlineBody(!enabled),
            style: {
              flex: 'none',
              border: `1px solid ${enabled ? C.brand : C.border}`,
              background: enabled ? C.brand : 'transparent',
              color: enabled ? '#fff' : C.muted,
              borderRadius: 999,
              padding: '3px 12px',
              fontSize: 11,
              cursor: 'pointer',
            },
          },
          enabled ? t('settings.on') : t('settings.off'),
        ),
      )
    }

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
        h(InlineBodySwitch, {}),
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
      'tab.context': '所见',
      'iui.title': '可组合 IUI（实验）',
      'iui.hint': '受信组件树 + 局部状态：切换时间范围只改本地状态，不请求模型；坏节点整段降级。',
      'iui.sampleInteractive': '示例：指标 + 趋势 + 切换',
      'iui.sampleCompare': '示例：两列对比',
      'iui.sampleBroken': '示例：坏 AST 降级',
      'dsl.title': '实验性 IUI（预览）',
      'dsl.on': '开',
      'dsl.off': '关',
      'dsl.hint': '默认关闭。这是实验入口：DSL 在本地编译成受校验的 AST，只渲染已知组件，不执行任何模型给的脚本或样式；关闭后不影响正常聊天。',
      'dsl.compile': '编译预览',
      'dsl.sampleChart': '示例：图表 + 说明',
      'dsl.sampleCompare': '示例：组合两块',
      'dsl.sampleBroken': '示例：坏样例',
      'tab.view': '视图',
      'inline.title': '展示',
      'inline.preparing': '正在准备展示…',
      'inline.pending': '这一条不是展示指令。',
      'view.empty': '还没有展示内容。让我画点东西时会出现在这里。',
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
      'settings.inlineBody': '正文内嵌卡片',
      'settings.inlineBodyHint': '关掉就退回原生渲染：卡片只以独立行出现，正文不再被接管。',
      'settings.on': '开',
      'settings.off': '关',
      'settings.hotReload': '本页只读：以配置文件为唯一来源，避免界面与文件产生两份不一致的配置。',
    }

    const en = {
      'tab.graph': 'Fishbone',
      'tab.list': 'List',
      'tab.stream': 'Stream',
      'tab.context': 'Seen',
      'iui.title': 'Composable IUI (experimental)',
      'iui.hint': 'Trusted component tree with local state: switching the range only updates local state, no model call. A bad node degrades its own subtree.',
      'iui.sampleInteractive': 'Sample: metrics + trend + switch',
      'iui.sampleCompare': 'Sample: two-column compare',
      'iui.sampleBroken': 'Sample: broken AST',
      'dsl.title': 'Experimental IUI (preview)',
      'dsl.on': 'on',
      'dsl.off': 'off',
      'dsl.hint': 'Off by default. Local compile to a validated AST; only known components render, no model-supplied scripts or styles. Normal chat is unaffected when off.',
      'dsl.compile': 'Compile preview',
      'dsl.sampleChart': 'Sample: chart + prose',
      'dsl.sampleCompare': 'Sample: two blocks',
      'dsl.sampleBroken': 'Sample: broken input',
      'tab.view': 'View',
      'inline.title': 'View',
      'inline.preparing': 'Preparing…',
      'inline.pending': 'Not a view command.',
      'view.empty': 'Nothing shown yet.',
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
      'settings.inlineBody': 'Cards inside the body',
      'settings.inlineBodyHint': 'Turn off to hand the message row back to native rendering; cards then only appear as their own rows.',
      'settings.on': 'on',
      'settings.off': 'off',
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

        // 嵌在会话正文里的展示：ink_view 的调用自己长成一行卡片（Turn 层，不进可折叠的过程组）。
        ctx.inject(['uiConversation'], (inner) => {
          inner.effect(() => inner.uiConversation.events.register(widgetNodeDefinition), 'miopiik-dsh: widget node')
          inner.slots.inject('conversation.chat.node', () => {
            inner.slots.register({ name: 'conversation.chat.node', key: WIDGET_NODE_KIND, locale: NS }, WidgetNodeView)
            if (primitives === null) return
            // 正文内嵌 = 接管这一行；开关走注册/注销，不必重启。
            inlineBodyControl.register = () =>
              inner.slots.register({ name: 'conversation.chat.node', key: 'assistant-step', priority: -1, locale: NS }, InlineBodyRow)
            if (inlineBody.get().enabled) inlineBodyControl.dispose = inlineBodyControl.register()
          })
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
