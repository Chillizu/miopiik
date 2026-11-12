/**
 * assistant 消息块 → 渲染计划（纯函数，Host/Client 共用，无 DOM 依赖）。
 *
 * 为什么单独抽出来：之前内联渲染直接在 for 循环里用 `return` 做"跳过"，
 * 结果第一个不匹配的块就退出了整个组件，普通正文整段消失（P0）。
 * 现在分类逻辑集中在这里，组件只做"映射"，不允许提前 return。
 */

export const ASSISTANT_BLOCK_KINDS = Object.freeze(['text', 'reasoning', 'images', 'unknown'])

/**
 * @param blocks assistant 消息的 block 数组（不可信，可能含 null）
 * @param groupPart 该节点在回合里的分组：'reasoning' | 'response' | undefined
 * @returns {Array<{kind:string, text?:string, images?:Array, block?:unknown}>}
 */
export function planAssistantBlocks(blocks, groupPart) {
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
