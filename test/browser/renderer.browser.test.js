import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const bundle = readFileSync(join(root, 'miopiik-iui', 'client.js'), 'utf8')
const folder = join(root, '.dsh', 'tmp', 'browser-test')
const CHROMIUM = process.env.CHROMIUM_PATH ?? 'chromium'

function fixture() {
  const setup = `
    const failures = [];
    window.addEventListener('error', e => failures.push(String(e.message)));
    let plugin;
    window.__ModuleLoader__ = { load(v) { plugin = v } };
    const SVG = new Set(['svg','g','path','rect','text','defs','marker','polyline','line','circle']);
    function h(type, props, ...children) {
      props = props || {};
      if (typeof type === 'function') return type({...props, children});
      const el = SVG.has(type) ? document.createElementNS('http://www.w3.org/2000/svg',type) : document.createElement(type);
      for (const [key,val] of Object.entries(props)) {
        if (val === null || val === undefined || key === 'key' || key === 'ref') continue;
        if (key === 'style') { for(const [prop,raw] of Object.entries(val)) el.style[prop] = typeof raw === 'number' && !['opacity','lineHeight','fontWeight','flexGrow','flexShrink','order','zIndex'].includes(prop) ? raw+'px' : raw; continue; }
        if (key.startsWith('on') && typeof val === 'function') { el.addEventListener(key.slice(2).toLowerCase(),val);continue; }
        if (key === 'className') { el.className = val; continue; }
        el.setAttribute(key,String(val));
      }
      for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false) continue;
        el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
      }
      return el;
    }
    const React = {createElement:h, useState(v) {return [typeof v==='function'?v():v, ()=>{}]}, useEffect(){}, useMemo(fn){return fn()}, useCallback(fn){return fn()}};
  `
  const run = `
    const slots=[];
    const module=plugin.factory(name => {if(name==='react')return React;throw Error('unexpected module '+name)});
    module.apply({effect(){},slots:{inject(name,callback){if(name!=='plugins.bundle.config')throw Error('wrong slot');callback()},register(meta,render){slots.push({meta,render})}}});
    const form=slots[0].render({view:'page'});
    document.getElementById('root').appendChild(form);
    document.body.dataset.integration=slots.length===1 && slots[0].meta.key==='miopiik-iui'?'ok':'failed';
    document.body.dataset.errors=failures.join('|');
  `
  return '<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><main id="root" style="width:650px;max-width:100%"></main><script>' + setup + '\n' + bundle + '\n' + run + '</script></body></html>'
}

test('独立 IUI 配置在真实 Chromium DOM 中完整呈现，并使用真实渲染器预览', () => {
  mkdirSync(folder, {recursive:true})
  const file=join(folder,'iui-settings.html')
  writeFileSync(file,fixture())
  const html=execFileSync(CHROMIUM,['--headless=new','--no-sandbox','--disable-gpu','--hide-scrollbars','--user-data-dir='+join(folder,'settings-profile'),'--dump-dom','file://'+file],{encoding:'utf8',timeout:60000,stdio:['ignore','pipe','ignore']})
  assert.match(html,/data-integration="ok"/u,'插件注册必须成功')
  assert.match(html,/data-errors=""/u,'浏览器不应有运行时错误')
  assert.match(html,/data-iui-plugin-settings="1"/u)
  assert.match(html,/data-iui-settings-toggle="1"/u)
  assert.match(html,/role="switch"/u)
  assert.match(html,/data-iui-settings-preview="live"/u,'预览必须连接真实 IUI 注册表')
  assert.match(html,/data-iui-output="ok"/u,'预览应通过真正的 AST 渲染器')
  assert.match(html,/data-iui-registry-state="ready"/u)
  assert.doesNotMatch(html,/data-iui-chart-empty="1"/u,'预览图表不应为空')
})
