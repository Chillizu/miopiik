/** Host 侧薄封装：把校验函数注入纯 DSL 编译器（shared/ui-dsl.js）。 */
import { validateSpec } from '../shared/spec-rules.js'
import { compileInlineDsl as compile } from '../shared/ui-dsl.js'

export { comparePayloadCost } from '../shared/ui-dsl.js'

/** @param source 模型输出；@returns 片段数组（text / ui / 降级文本） */
export function compileInlineDsl(source) {
  return compile(source, validateSpec)
}
