import test from 'node:test'
import assert from 'node:assert/strict'

import { LOOP_TYPES, buildCandidateNote, parseConversationOutput } from '../miopiik-dsh/host/converse.js'
import { validateNote } from '../miopiik-dsh/host/notes.js'
import { TIER, tierOf } from '../miopiik-dsh/host/inbox.js'

const UTT = [
  { id: 'U-1', role: 'user', text: '就用收件箱吧，给 M 处理更确定。' },
  { id: 'U-2', role: 'assistant', text: '那模型默认继承会话。' },
  { id: 'U-3', role: 'user', text: '对，默认继承，也可以单独设。' },
]

test('对话编译：解析候选并保留可指认的出处', () => {
  const parsed = parseConversationOutput(
    '```json\n{"claims":[{"claim":"模型默认继承会话","refs":["U-2","U-9"],"conf":"mid"}],"loops":[],"question":"要记吗？"}\n```',
    UTT,
  )
  assert.equal(parsed.claims.length, 1)
  assert.deepEqual(parsed.claims[0].refs, ['U-2'], '指认不到的 U-n 必须被过滤')
  assert.equal(parsed.question, '要记吗？')
})

test('对话编译：没有出处的候选一律丢弃', () => {
  const parsed = parseConversationOutput(
    '{"claims":[{"claim":"没有任何根据的结论","refs":["U-99"]}],"loops":[{"type":"promise","text":"没有出处","refs":[]}]}',
    UTT,
  )
  assert.equal(parsed, null)
})

test('对话编译：未知开环类型被丢弃，不认识的字段不放大', () => {
  const parsed = parseConversationOutput(
    '{"claims":[],"loops":[{"type":"todo","text":"假类型","refs":["U-1"]},{"type":"promise","text":"之后给结论","refs":["U-3"],"closureCondition":"给出结论"}]}',
    UTT,
  )
  assert.equal(parsed.loops.length, 1)
  assert.equal(parsed.loops[0].type, 'promise')
  assert.ok(LOOP_TYPES.includes(parsed.loops[0].type))
})

test('对话编译：空产出返回 null，不造降级预览', () => {
  assert.equal(parseConversationOutput('{"claims":[],"loops":[]}', UTT), null)
  assert.equal(parseConversationOutput('不是 JSON', UTT), null)
})

test('候选组装成 note：带 U-n 指针，能过 note 校验', () => {
  const parsed = parseConversationOutput(
    '{"claims":[{"claim":"模型默认继承会话","refs":["U-2"],"conf":"mid"}],"loops":[{"type":"pending-option","text":"是否单独设模型","refs":["U-3"],"closureCondition":"用户拍板"}],"question":"要不要记为已定结论？"}',
    UTT,
  )
  const note = buildCandidateNote(parsed)
  assert.deepEqual(validateNote(note), [])
  assert.equal(note.why, 'compile:conversation')
  assert.equal(note.newConclusion, true)
  assert.ok(note.refs.includes('U-2'))
  assert.ok(note.detail.includes('候选开环'))
})

test('候选预览进收件箱是 T2（新结论），不是 T3', () => {
  const item = {
    id: 'I-1',
    noteId: 'D-1',
    loopId: null,
    branchId: null,
    blocking: false,
    newConclusion: true,
    epoch: 0,
    status: 'unread',
    claim: '候选',
    question: '要记吗？',
    createdAt: 0,
  }
  assert.equal(tierOf(item, { currentEpoch: 0, activeLoopIds: new Set() }), TIER.T2)
})
