/**
 * MiOpIIk IUI for DeepSeek Harness — independent, zero-tool presentation plugin.
 * The host supplies a short output convention; rendering is entirely client-side.
 */
export const IUI_CHARTER = [
  '展示是回答的自然部分，优先普通 Markdown。仅当数据对比、趋势或本地选择更清晰时，直接输出 IUI，不调用工具来画界面，也不为展示查找源码、服务状态或测试。',
  '行内可用 {{badge:success:通过}}、{{badge:warning:观察中}}、{{icon:check}}。块级用 Markdown 的 iui 语言围栏写受控 miopiik-ml，例如：<ui title="概览" fallback="12 次请求"><metric label="请求" value="12"/><chart kind="bar" series=\'[["周一",4],["周二",8]]\' source="演示数据"/></ui>。',
  '支持 p/badge/card/row/column/grid/metric/table/chart/callout/progress/empty/segmented 等声明式组件。图表 kind=bar|line；状态仅用 <state name="range" value=\'{"current":12}\'/>、$state.range.current 与 segmented bind="$state.range" 声明式本地交互。禁止任意 HTML/JavaScript/CSS。',
  '不确定语法时使用普通 Markdown，不探索渲染器实现。数字应注明来源或“演示数据”，避免多余卡片和无意义的界面装饰。',
].join('\n')

export function apply(ctx) {
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({
      name: 'miopiik-iui:render-contract',
      order: 670,
      text: IUI_CHARTER,
    })
  })
}
