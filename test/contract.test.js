import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CONTRACT_FIELDS,
  renderContractPrompt,
  renderDraftPrompt,
  validateContract,
  validateDraft,
} from '../host/contract.js'


const complete = {
  goal: '把竞品首页扫一遍，看定位是否成立',
  deliverables: '一张三列对照表',
  acceptance: '每家一条证据链接',
  acceptanceSample: '像这样：| 竞品 | 首页主张 | 证据 |',
  boundary: '不要改仓库里的任何文件',
  budget: '20 分钟 / 30 次工具调用',
}

test('契约六要素齐全才算正式派发', () => {
  assert.deepEqual(validateContract(complete), { ok: true, missing: [] })
  assert.equal(CONTRACT_FIELDS.length, 6)
})

test('缺任何一项都拒绝，并给出缺失清单（不是一句参数不对）', () => {
  const { ok, missing } = validateContract({ ...complete, acceptanceSample: '', boundary: '  ' })
  assert.equal(ok, false)
  assert.deepEqual(missing, ['验收样例（大概长这样）', '边界（不许改什么）'])
})

test('派发提示里 Operator 只看到契约，看不到对话', () => {
  const prompt = renderContractPrompt(complete)
  assert.match(prompt, /never talk to the user/)
  assert.match(prompt, /不要改仓库里的任何文件/)
  assert.match(prompt, /early shape/)
  assert.doesNotMatch(prompt, /用户说/)
})

test('草稿态：只要一句话目标就能跑，产出可丢弃（SPEC §4.4）', () => {
  assert.deepEqual(validateDraft({ goal: '看看竞品首页都在讲什么' }), { ok: true, missing: [] })
  assert.equal(validateDraft({}).ok, false)
  const prompt = renderDraftPrompt({ goal: '看看竞品首页都在讲什么' })
  assert.match(prompt, /DRAFT/)
  assert.match(prompt, /cheapest useful artifact/)
  assert.match(prompt, /State every assumption/)
})
