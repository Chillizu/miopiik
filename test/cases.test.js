import test from 'node:test'
import assert from 'node:assert/strict'

import { makeCase, matchCase, matchFacts, overlap, tokens } from '../miopiik-dsh/host/cases.js'

test('token 化：ASCII 词 + 中文二元组', () => {
  const set = tokens('SPEC 的版本号是多少')
  assert.ok(set.has('spec'))
  assert.ok(set.has('版本'))
  assert.ok(set.size >= 4)
})

test('重叠度量：相关句子有分，无关句子为 0', () => {
  const a = 'Mio 的中间层叫什么名字'
  assert.ok(overlap(a, '中间层的名字是 Pio') > 0.1)
  assert.equal(overlap('天气怎么样', '中间层的名字是 Pio'), 0)
})

test('判例匹配：相似问题命中，不相关问题不命中', () => {
  const cases = [
    makeCase({ id: 'C-1', question: '中间的层叫什么', answer: 'Pio', citations: ['F-1'] }),
    makeCase({ id: 'C-2', question: '部署脚本在哪', answer: 'deploy/', citations: ['F-2'] }),
  ]
  const hit = matchCase('中间那一层叫什么来着', cases)
  assert.equal(hit?.case.id, 'C-1')
  assert.equal(matchCase('今天吃什么', cases), null)
})

test('事实卡匹配：找到最相关的一张', () => {
  const facts = [
    { id: 'F-1', claim: '中间层叫 Ink/Pio，负责编译与记账' },
    { id: 'F-2', claim: '事实卡只增不删，可标失效' },
  ]
  const hit = matchFacts('中间层负责什么', facts)
  assert.equal(hit?.fact.id, 'F-1')
})
