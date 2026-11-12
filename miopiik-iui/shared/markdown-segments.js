/**
 * Markdown 正文切分：把"受信 token"从普通 Markdown 里切出来，其余原样交给 MarkdownText。
 *
 * 只认两种受控标记，绝不把任意 HTML 当组件：
 *   - 块级：```iui 围栏（Miopiik ML 或 JSON AST）
 *   - 行内：{{badge:success:已实现}} / {{icon:check}} / {{code:iapi}}
 *
 * 设计约束：
 *   - 只做切分，不做 HTML/JS 解析；未知或格式不正确的 token 原样留在文本里；
 *   - 切分点只在标记边界，跨标记的 Markdown 结构（如跨越 token 的加粗）会各自渲染——已记录为限制；
 *   - 返回顺序即渲染顺序，保证"同一行文字混排"。
 */

export const INLINE_TOKEN = /\{\{(badge|icon|code):([^{}\n]{1,120}?)\}\}/gu
export const BLOCK_FENCE = /```iui[ \t]*\r?\n([\s\S]*?)```/gu

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
    parts.push({ kind: 'block', raw: fence[1] })
    cursor = fence.index + fence[0].length
    fence = BLOCK_FENCE.exec(source)
  }
  pushTrustedInline(source.slice(cursor), pushText, parts)
  return parts.length === 0 ? [{ kind: 'text', text: source }] : parts
}

function pushTrustedInline(text, pushText, parts) {
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
