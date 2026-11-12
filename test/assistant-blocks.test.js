import test from 'node:test'
import assert from 'node:assert/strict'

import { planAssistantBlocks } from '../miopiik-dsh/shared/assistant-blocks.js'

const kinds = (plan) => plan.map((item) => item.kind)

test('正文（response）：reasoning→text 连续块不吞内容', () => {
  const plan = planAssistantBlocks(
    [
      { kind: 'reasoning', text: '想法一' },
      { kind: 'text', text: '正文一' },
      { kind: 'reasoning', text: '想法二' },
      { kind: 'text', text: '正文二' },
    ],
    'response',
  )
  assert.deepEqual(kinds(plan), ['text', 'text'])
  assert.deepEqual(plan.map((p) => p.text), ['正文一', '正文二'])
})

test('推理（reasoning）：只有 reasoning 块，空推理被跳过但后续不丢', () => {
  const plan = planAssistantBlocks(
    [
      { kind: 'reasoning', text: '   ' },
      { kind: 'reasoning', text: '真正的推理' },
      { kind: 'text', text: '正文不该出现在推理组' },
    ],
    'reasoning',
  )
  assert.deepEqual(kinds(plan), ['reasoning'])
  assert.equal(plan[0].text, '真正的推理')
})

test('多段正文 + 工具调用 + null 块 + 未知块：全都保留或安全跳过', () => {
  const plan = planAssistantBlocks(
    [
      { kind: 'text', text: '第一段' },
      null,
      { kind: 'tool-call' },
      { kind: 'text', text: '第二段' },
      { kind: 'image', attachment: { id: 'a' } },
      { kind: 'image', attachment: { id: 'b' } },
      { kind: 'text', text: '第三段' },
    ],
    undefined,
  )
  assert.deepEqual(kinds(plan), ['text', 'text', 'images', 'text'])
  assert.equal(plan[0].text, '第一段')
  assert.equal(plan[1].text, '第二段')
  assert.equal(plan[2].images.length, 2, '连续图片必须合成一组')
  assert.equal(plan[3].text, '第三段')
})

test('没有 blocks / 非数组时不抛错', () => {
  assert.deepEqual(planAssistantBlocks(undefined), [])
  assert.deepEqual(planAssistantBlocks(null, 'response'), [])
  assert.deepEqual(planAssistantBlocks('nope'), [])
})
