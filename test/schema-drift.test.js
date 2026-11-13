import test from 'node:test'
import assert from 'node:assert/strict'

import { syncCheck } from '../tools/build-client-rules.mjs'

test('MiOpIIk Agent 不再打包旧 Widget/IUI 协议，独立插件唯一负责渲染', () => {
  const result = syncCheck()
  assert.equal(result.ok, true, result.reason ?? 'Standalone IUI renderer missing')
})
