import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const clientPath = join(root, 'miopiik-dsh', 'client.js')
const outDir = join(root, '.dsh', 'tmp', 'browser-test')

const CHROMIUM = process.env.CHROMIUM_PATH ?? 'chromium'

/** 从 client.js 里抽出「渲染层」那一段（markers 固定，抽取失败直接失败而不是静默跳过）。 */
function extractRenderer() {
  const source = readFileSync(clientPath, 'utf8')
  const start = source.indexOf('    // SVG 画布：viewBox 固定')
  const end = source.indexOf('    // 对话流里的卡片节点')
  assert.ok(start > 0 && end > start, 'client.js 渲染层 markers 丢失，测试无法抽取')
  return source.slice(start, end)
}

function page(renderer) {
  return `<!doctype html><meta charset="utf-8"><body><div id="root"></div><script>
const ERRORS = [];
window.addEventListener('error', (e) => ERRORS.push(String(e.message)));
const SVG = new Set(['svg','g','path','rect','text','defs','marker','polyline','line','circle']);
const CAMEL = new Set(['viewBox','preserveAspectRatio','markerWidth','markerHeight','markerUnits','refX','refY']);
function attrName(n){ return CAMEL.has(n) ? n : n.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()); }
function h(tag, props, ...children) {
  if (typeof tag === 'function') return tag(props || {});
  const el = document.createElementNS(SVG.has(tag) ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml', tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'key' || v === undefined || v === null) continue;
    if (k === 'style') { for (const [sk, sv] of Object.entries(v)) el.style[sk] = typeof sv === 'number' ? sv + 'px' : sv; continue; }
    if (SVG.has(tag)) el.setAttribute(attrName(k), v);
    else if (k === 'className') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  return el;
}
const C = { base:'#fff', layer1:'#fafafb', border:'#e3e3e6', borderStrong:'#cfd0d4', text:'#1b1b1b', muted:'#77787c', brand:'#4176e6', link:'#8b8d94' };
${renderer}
const root = document.getElementById('root');
const cases = [];
function add(label, spec) {
  const wrap = document.createElement('div');
  const tag = document.createElement('div');
  tag.textContent = label;
  wrap.appendChild(tag);
  try {
    wrap.appendChild(h(WidgetCard, { spec }));
    cases.push(label + ':ok');
  } catch (error) {
    cases.push(label + ':THROW:' + String(error && error.message));
  }
  document.getElementById('root').appendChild(wrap);
}
// 1) 正常图表
add('dataset', { widget:'dataset', preset:'card', title:'t', props:{ chart:true, columns:[{label:'a'},{label:'b'}], rows:[['x',1],['y',2]] }, fallback:'正常图' });
// 2) 隔离：渲染器内部会抛错的图（null 节点）——必须降级而不是抛穿
add('nullgraph', { widget:'graph', preset:'card', title:'g', props:{ nodes:[null], edges:[] }, fallback:'FALLBACK-NULL-GRAPH' });
// 3) 未知形状
add('unknown', { widget:'mermaid', preset:'card', props:{}, fallback:'FALLBACK-UNKNOWN' });
document.body.setAttribute('data-cases', cases.join('|'));
document.body.setAttribute('data-errors', ERRORS.join('|'));
</script></body>`;
}

test('浏览器回归：非法 spec 只降级当块，不崩页面、不抛穿', () => {
  const renderer = extractRenderer()
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, 'renderer.html')
  writeFileSync(file, page(renderer), 'utf8')
  const dom = execFileSync(
    CHROMIUM,
    ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${join(outDir, 'profile')}`, '--dump-dom', `file://${file}`],
    { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] },
  )
  const cases = /data-cases="([^"]*)"/u.exec(dom)?.[1] ?? ''
  const errors = /data-errors="([^"]*)"/u.exec(dom)?.[1] ?? ''
  assert.match(cases, /dataset:ok/u)
  assert.match(cases, /nullgraph:ok/u, '渲染器抛错必须被 WidgetCard 隔离')
  assert.match(cases, /unknown:ok/u)
  assert.equal(errors, '', '页面不应有未捕获异常')
  assert.match(dom, /FALLBACK-NULL-GRAPH/u, '降级时必须显示 fallback 文本')
  assert.match(dom, /FALLBACK-UNKNOWN/u)
})
