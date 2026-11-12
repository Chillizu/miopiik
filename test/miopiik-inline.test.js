import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { validateAst } from '../miopiik-iui/shared/iui-ast.js'
import { parseMiopiikMl } from '../miopiik-iui/shared/miopiik-ml.js'

const SRC = `<ui fallback="f">
  <column gap="8">
    <p>新版正文接入 <badge tone="success">已实现</badge>，折叠 <badge tone="warning">待修复</badge>，见 <a href="https://example.com">文档</a> 与 <code>iapi</code>。</p>
    <callout tone="warning" title="边界">这一条是块级提示。</callout>
    <progress label="迁移" value="0.6"/>
    <empty text="暂无数据"/>
  </column>
</ui>`

test('行内混排：文字与 badge/link/code 在同一 paragraph，顺序保留', () => {
  const parsed = parseMiopiikMl(SRC)
  assert.equal(parsed.ok, true)
  const paragraph = parsed.doc.root.children[0]
  assert.equal(paragraph.type, 'paragraph')
  const kinds = paragraph.children.map((node) => node.type)
  assert.deepEqual(kinds, ['text', 'badge', 'text', 'badge', 'text', 'link', 'text', 'code', 'text'])
  // 中文文本必须原样保留（UTF-8 不乱码、不丢空格）
  assert.equal(paragraph.children[0].props.text, '新版正文接入 ')
  assert.equal(paragraph.children[2].props.text, '，折叠 ')
  assert.equal(paragraph.children[1].props.text, '已实现')
  const checked = validateAst(parsed.doc)
  assert.equal(checked.ok, true)
  assert.equal(checked.degraded, 0)
})

test('块级反馈原语：callout/progress/empty 通过校验', () => {
  const checked = validateAst(parseMiopiikMl(SRC).doc)
  const types = checked.ast.root.children.map((node) => node.type)
  assert.deepEqual(types, ['paragraph', 'callout', 'progress', 'empty'])
})

test('安全：paragraph 里塞块级组件、非法 tone、非 https 链接、白名单外图标都只降级该节点', () => {
  const bad = parseMiopiikMl(`<ui fallback="f"><column>
    <p>正常文字 <metric label="x" value="1"/></p>
    <badge tone="rainbow">x</badge>
    <a href="javascript:alert(1)">危险</a>
    <icon name="skull"/>
    <text>兄弟保留</text>
  </column></ui>`)
  assert.equal(bad.ok, true)
  const checked = validateAst(bad.doc)
  assert.equal(checked.ok, true, '局部降级不应整份拒绝')
  assert.ok(checked.degraded >= 3, `应至少有 3 处降级，实际 ${checked.degraded}`)
  assert.equal(checked.ast.root.children.at(-1).props.text, '兄弟保留')
  // 危险链接永远不会成为可点击的 link 节点
  const serialized = JSON.stringify(checked.ast)
  assert.equal(serialized.includes('javascript:'), false)
})

test('IUI 已从 MiOpIIk 主客户端抽离：独立插件拥有注册表，主客户端没有覆盖席位', () => {
  const main = readFileSync(new URL('../miopiik-dsh/client.js', import.meta.url), 'utf8')
  const standalone = readFileSync(new URL('../miopiik-iui/client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(main, /globalThis\.__miopiikMarkdownEmbeds\s*=/u)
  assert.doesNotMatch(main, /key: 'assistant-step', priority/u)
  assert.match(standalone, /globalThis\.__miopiikMarkdownEmbeds\s*=\s*registry/u)
})
