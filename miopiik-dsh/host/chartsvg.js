/**
 * 图表 → SVG 文件（Host 侧渲染）。
 *
 * 为什么在服务端画：DSH 原生就把「正文里的本地图」当一等公民（markdown 图片目的地 →
 * api/file?path= → image/svg+xml）。所以图表不必依赖客户端接管，画成 SVG 落盘、
 * 正文里用 `![](path)` 引用，就得到原生内嵌——可导出、可离线看、不随前端版本漂移。
 *
 * 这里是纯字符串生成：没有 DOM、没有设计 token 运行时；颜色烘焙成浅色主题的值，
 * 深色主题下靠外层给 SVG 一个背景（见 Card 的样式）。
 */

const W = 720
const H = 340
const PAD_L = 48
const PAD_R = 24
const PAD_T = 28
const PAD_B = 48

const COLORS = {
  brand: '#4176e6',
  text: '#1b1b1b',
  muted: '#77787c',
  border: '#e3e3e6',
  base: '#ffffff',
  palette: ['#4176e6', '#2e9e5b', '#c98a1b', '#8b8d94', '#cf4444'],
}

const SANS = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif'

/** 属性值里不允许裸引号/尖括号，否则整份 SVG 就不是合法 XML。 */
function attr(value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/"/gu, '&quot;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
}

function escapeText(value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
}

function titleBlock(title) {
  if (typeof title !== 'string' || title.trim() === '') return ''
  return `<text x="${PAD_L}" y="18" font-size="13" font-weight="600" fill="${COLORS.text}" font-family="${attr(SANS)}">${escapeText(title)}</text>`
}

function barChart(rows) {
  const values = rows.map((row) => Number(row[1]) || 0)
  const labels = rows.map((row) => String(row[0] ?? ''))
  const max = Math.max(1, ...values)
  const plotW = W - PAD_L - PAD_R
  const plotH = H - PAD_T - PAD_B
  const slot = plotW / Math.max(1, rows.length)
  const barW = Math.min(72, slot * 0.55)
  const parts = []
  parts.push(`<line x1="${PAD_L}" y1="${H - PAD_B}" x2="${W - PAD_R}" y2="${H - PAD_B}" stroke="${COLORS.border}" stroke-width="1"/>`)
  values.forEach((value, index) => {
    const barH = Math.max(2, Math.round((value / max) * (plotH - 24)))
    const x = PAD_L + slot * index + (slot - barW) / 2
    const y = H - PAD_B - barH
    parts.push(`<rect x="${Math.round(x)}" y="${y}" width="${Math.round(barW)}" height="${barH}" rx="4" fill="${COLORS.brand}"/>`)
    parts.push(`<text x="${Math.round(x + barW / 2)}" y="${y - 7}" font-size="12" fill="${COLORS.text}" font-family="${attr(SANS)}" text-anchor="middle">${escapeText(value)}</text>`)
    parts.push(`<text x="${Math.round(x + barW / 2)}" y="${H - PAD_B + 18}" font-size="11" fill="${COLORS.muted}" font-family="${attr(SANS)}" text-anchor="middle">${escapeText(labels[index])}</text>`)
  })
  return parts.join('')
}

function lineChart(rows) {
  const values = rows.map((row) => Number(row[1]) || 0)
  const labels = rows.map((row) => String(row[0] ?? ''))
  const max = Math.max(1, ...values)
  const plotW = W - PAD_L - PAD_R
  const plotH = H - PAD_T - PAD_B
  const step = rows.length > 1 ? plotW / (rows.length - 1) : 0
  const points = values.map((value, index) => ({
    x: PAD_L + step * index,
    y: H - PAD_B - (value / max) * (plotH - 24),
  }))
  const parts = []
  parts.push(`<line x1="${PAD_L}" y1="${H - PAD_B}" x2="${W - PAD_R}" y2="${H - PAD_B}" stroke="${COLORS.border}" stroke-width="1"/>`)
  parts.push(
    `<polyline points="${points.map((point) => `${Math.round(point.x)},${Math.round(point.y)}`).join(' ')}" fill="none" stroke="${COLORS.brand}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  )
  points.forEach((point, index) => {
    parts.push(`<circle cx="${Math.round(point.x)}" cy="${Math.round(point.y)}" r="3.5" fill="${COLORS.brand}"/>`)
    parts.push(`<text x="${Math.round(point.x)}" y="${Math.round(point.y) - 9}" font-size="11" fill="${COLORS.text}" font-family="${attr(SANS)}" text-anchor="middle">${escapeText(values[index])}</text>`)
    parts.push(`<text x="${Math.round(point.x)}" y="${H - PAD_B + 18}" font-size="11" fill="${COLORS.muted}" font-family="${attr(SANS)}" text-anchor="middle">${escapeText(labels[index])}</text>`)
  })
  return parts.join('')
}

function donutChart(rows) {
  const values = rows.map((row) => Number(row[1]) || 0)
  const labels = rows.map((row) => String(row[0] ?? ''))
  const total = values.reduce((sum, value) => sum + value, 0) || 1
  const cx = 150
  const cy = H / 2 + 8
  const radius = 88
  const thickness = 34
  const circumference = 2 * Math.PI * radius
  const parts = []
  let offset = 0
  values.forEach((value, index) => {
    const length = (value / total) * circumference
    parts.push(
      `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${COLORS.palette[index % COLORS.palette.length]}" stroke-width="${thickness}" stroke-dasharray="${Math.max(0, length - 3)} ${circumference}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})"/>`,
    )
    offset += length
  })
  labels.forEach((label, index) => {
    const y = PAD_T + 46 + index * 30
    parts.push(`<rect x="${300}" y="${y - 11}" width="11" height="11" rx="2" fill="${COLORS.palette[index % COLORS.palette.length]}"/>`)
    parts.push(`<text x="${320}" y="${y}" font-size="12" fill="${COLORS.text}" font-family="${attr(SANS)}">${escapeText(label)}</text>`)
    parts.push(`<text x="${W - PAD_R}" y="${y}" font-size="12" fill="${COLORS.muted}" font-family="${attr(SANS)}" text-anchor="end">${escapeText(values[index])}</text>`)
  })
  return parts.join('')
}

function graphMap(props) {
  const nodes = Array.isArray(props?.nodes) ? props.nodes : []
  const edges = Array.isArray(props?.edges) ? props.edges : []
  const lanes = []
  for (const node of nodes) {
    const lane = String(node.lane ?? '')
    if (!lanes.includes(lane)) lanes.push(lane)
  }
  const nodeW = 132
  const nodeH = 40
  const colGap = 64
  const rowGap = 18
  const pad = 16
  const laneRows = lanes.map((lane) => nodes.filter((node) => String(node.lane ?? '') === lane))
  const maxRows = Math.max(1, ...laneRows.map((rows) => rows.length))
  const width = pad * 2 + lanes.length * nodeW + Math.max(0, lanes.length - 1) * colGap
  const height = pad * 2 + maxRows * nodeH + Math.max(0, maxRows - 1) * rowGap
  const position = new Map()
  lanes.forEach((lane, laneIndex) => {
    const rows = laneRows[laneIndex]
    const offset = ((maxRows - rows.length) * (nodeH + rowGap)) / 2
    rows.forEach((node, rowIndex) => {
      position.set(String(node.id ?? node.label ?? ''), {
        x: pad + laneIndex * (nodeW + colGap),
        y: pad + offset + rowIndex * (nodeH + rowGap),
        laneIndex,
      })
    })
  })
  const parts = []
  const laneBottom = pad + maxRows * nodeH + Math.max(0, maxRows - 1) * rowGap
  let below = 0
  for (const edge of edges) {
    const from = position.get(String(edge.from))
    const to = position.get(String(edge.to))
    if (from === undefined || to === undefined) continue
    if (from.laneIndex === to.laneIndex) {
      const cx = from.x + nodeW / 2
      const down = to.y > from.y
      const y1 = down ? from.y + nodeH : from.y
      const y2 = down ? to.y : to.y + nodeH
      if (Math.abs(y2 - y1) < 2) continue
      parts.push(`<line x1="${Math.round(cx)}" y1="${Math.round(y1)}" x2="${Math.round(cx)}" y2="${Math.round(y2)}" stroke="${COLORS.muted}" stroke-width="1.2"/>`)
    } else if (to.laneIndex > from.laneIndex) {
      const x1 = from.x + nodeW
      const x2 = to.x
      const y1 = from.y + nodeH / 2
      const y2 = to.y + nodeH / 2
      const bend = Math.max(16, Math.abs(x2 - x1) * 0.45)
      parts.push(`<path d="M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}" fill="none" stroke="${COLORS.muted}" stroke-width="1.2"/>`)
    } else {
      const offsetX = Math.round(nodeW * 0.26)
      const x1 = from.x + nodeW / 2 + offsetX
      const x2 = to.x + nodeW / 2 + offsetX
      const dip = laneBottom + 18
      parts.push(`<path d="M${x1},${from.y + nodeH} C${x1},${dip} ${x2},${dip} ${x2},${to.y + nodeH}" fill="none" stroke="${COLORS.muted}" stroke-width="1.2"/>`)
      below = 30
    }
  }
  nodes.forEach((node) => {
    const spot = position.get(String(node.id ?? node.label ?? ''))
    if (spot === undefined) return
    parts.push(`<rect x="${Math.round(spot.x)}" y="${Math.round(spot.y)}" width="${nodeW}" height="${nodeH}" rx="8" fill="${COLORS.base}" stroke="${COLORS.border}" stroke-width="1"/>`)
    parts.push(`<text x="${Math.round(spot.x + nodeW / 2)}" y="${Math.round(spot.y + nodeH / 2 + 4)}" font-size="11" fill="${COLORS.text}" font-family="${attr(SANS)}" text-anchor="middle">${escapeText(node.label ?? node.id ?? '')}</text>`)
  })
  return { body: parts.join(''), width, height: height + below }
}

/** 把一份 spec 画成 SVG 字符串；不认识的就返回 null（调用方降级）。 */
export function renderSpecSvg(spec) {
  if (spec === null || typeof spec !== 'object') return null
  const props = spec.props ?? {}
  const title = titleBlock(spec.title)
  const rows = Array.isArray(props.rows) ? props.rows : []
  if (spec.widget === 'dataset') {
    const chart = props.chart === true ? 'bar' : String(props.chart ?? '')
    let body = null
    if (chart === 'bar') body = barChart(rows)
    else if (chart === 'line') body = lineChart(rows)
    else if (chart === 'donut') body = donutChart(rows)
    if (body === null) return null
    return svg(W, H, `${title}${body}`)
  }
  if (spec.widget === 'graph') {
    const map = graphMap(props)
    const width = Math.max(map.width, 320)
    return svg(width, Math.max(map.height + 8, 180), `${map.body}`)
  }
  return null
}

function svg(width, height, body) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">`,
    `<rect x="0" y="0" width="${width}" height="${height}" rx="10" fill="${COLORS.base}"/>`,
    body,
    '</svg>',
  ].join('')
}
