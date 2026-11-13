/**
 * Markdown 正文切分：把"受信 token"从普通 Markdown 里切出来，其余原样交给 MarkdownText。
 *
 * 只认受控标记，绝不把任意 HTML 当组件：
 *   - 块级：```iui 围栏（miopiik-ml 或 JSON AST）；```ink-view 仅历史只读兼容
 *   - 块级容错：模型忘了写围栏时，行首独立出现的顶层 <ui>…</ui> 也按受控 ML 解析
 *     （仍走同一套 AST 校验；解析失败原样保留为文本，不执行任何 HTML）
 *   - 行内：{{badge:success:已实现}} / {{icon:check}} / {{code:iapi}}
 *
 * 设计约束：
 *   - 只做切分，不做 HTML/JS 解析；未知或格式不正确的 token 原样留在文本里；
 *   - 切分点只在标记边界，跨标记的 Markdown 结构（如跨越 token 的加粗）会各自渲染——已记录为限制；
 *   - 返回顺序即渲染顺序，保证"同一行文字混排"。
 */

export const INLINE_TOKEN = /\{\{(badge|icon|code):([^{}\n]{1,120}?)\}\}/gu
// 新主路径是 ```iui；```ink-view 只为历史消息保留只读兼容（渲染前会转成新 AST）。
export const BLOCK_FENCE = /```(iui|ink-view)[ \t]*\r?\n([\s\S]*?)```/gu

function readInline(kind, payload) {
  if (kind === 'icon') {
    const name = payload.trim()
    return { type: 'icon', props: { name, label: name } }
  }
  if (kind === 'code') return { type: 'code', props: { text: payload } }
  // badge: tone:文本；tone 省略时按 neutral
  const match = /^(neutral|success|warning|danger):([\s\S]+)$/u.exec(payload.trim())
  if (match !== null) return { type: 'badge', props: { tone: match[1], text: match[2].trim() } }
  return { type: 'badge', props: { tone: 'neutral', text: payload.trim() } }
}

/**
 * @param text 模型输出的正文
 * @returns {Array<{kind:'text', text:string} | {kind:'block', raw:string} | {kind:'inline', node:object}>}
 */
export function splitTrustedMarkdown(text) {
  const source = String(text ?? '')
  const parts = []
  const pushText = (value) => {
    if (value !== '') parts.push({ kind: 'text', text: value })
  }
  let cursor = 0
  // 先切块级围栏，再在每段普通文本里切行内 token
  BLOCK_FENCE.lastIndex = 0
  let fence = BLOCK_FENCE.exec(source)
  while (fence !== null) {
    pushTrustedInline(source.slice(cursor, fence.index), pushText, parts)
    parts.push({ kind: 'block', raw: fence[2], lang: fence[1] })
    cursor = fence.index + fence[0].length
    fence = BLOCK_FENCE.exec(source)
  }
  pushTrustedInline(source.slice(cursor), pushText, parts)
  return parts.length === 0 ? [{ kind: 'text', text: source }] : parts
}

/** 其他语言的代码围栏：里面的内容一律原样保留，不识别 UI/行内标记。 */
const CODE_FENCE = /```[A-Za-z0-9_-]*[ \t]*\r?\n[\s\S]*?```/gu
/** 行首独立出现的顶层 <ui>…</ui>：模型偶尔忘了写围栏，仍按受控 ML 处理。 */
const BARE_UI = /(?:^|\n)[ \t]*(<ui\b[\s\S]*?<\/ui>)/gu

function pushTrustedInline(text, pushText, parts) {
  if (text === '') return
  let cursor = 0
  const handlePlain = (plain) => {
    BARE_UI.lastIndex = 0
    let bare = BARE_UI.exec(plain)
    let innerCursor = 0
    while (bare !== null) {
      pushInlineTokens(plain.slice(innerCursor, bare.index), pushText, parts)
      // 保留块前必要的换行，避免把上一段文字粘到块里
      parts.push({ kind: 'block', raw: bare[1], lang: 'ml-bare' })
      innerCursor = bare.index + bare[0].length
      bare = BARE_UI.exec(plain)
    }
    pushInlineTokens(plain.slice(innerCursor), pushText, parts)
  }
  CODE_FENCE.lastIndex = 0
  let fence = CODE_FENCE.exec(text)
  while (fence !== null) {
    handlePlain(text.slice(cursor, fence.index))
    pushText(fence[0])
    cursor = fence.index + fence[0].length
    fence = CODE_FENCE.exec(text)
  }
  handlePlain(text.slice(cursor))
}

function pushInlineTokens(text, pushText, parts) {
  if (text === '') return
  INLINE_TOKEN.lastIndex = 0
  let cursor = 0
  let match = INLINE_TOKEN.exec(text)
  while (match !== null) {
    pushText(text.slice(cursor, match.index))
    parts.push({ kind: 'inline', node: readInline(match[1], match[2]) })
    cursor = match.index + match[0].length
    match = INLINE_TOKEN.exec(text)
  }
  pushText(text.slice(cursor))
}

/** 是否含任何受信标记（用于快速路径：没有标记时行为与原生完全一致）。 */
export function hasTrustedMarkup(text) {
  const source = String(text ?? '')
  BLOCK_FENCE.lastIndex = 0
  if (BLOCK_FENCE.test(source)) return true
  INLINE_TOKEN.lastIndex = 0
  return INLINE_TOKEN.test(source)
}
