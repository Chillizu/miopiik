import test from 'node:test'
import assert from 'node:assert/strict'

import { syncCheck } from '../tools/build-client-rules.mjs'

test('client.js 里内联的 spec-rules 与真源一致（防两套校验漂移）', () => {
  const result = syncCheck()
  assert.equal(result.ok, true, '请运行 node tools/build-client-rules.mjs')
})
