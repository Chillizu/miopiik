# 上游提案：Markdown 受信嵌入扩展点（草案 v1）

> 状态：提案，未实现。作者：MiOpIIk Extra 层（ChromeChat 独立复核）。
> 目标：让插件把**受信任的嵌入组件**放进 DSH 原生 Markdown 流里，而**不替换 assistant-step**。
> 非目标：不改 Markdown 解析器语义、不执行模型提供的 HTML/JS/CSS、不改日志契约。

## 1. 现状（已核对的事实）

| 事实 | 位置 |
|---|---|
| `conversation.chat.node` 是 **keyed 槽**，重复 key 替换该 `ChatNodeKind` 的整个 renderer | `dsh-client-ui-chat/lib/types/client/contract/slots.d.ts` |
| `assistant-step` 被替换后，原生 `ReasoningRow`（折叠壳、summary、streaming、a11y）不再参与渲染 | 同上 + `ReasoningRow.d.ts` |
| `conversation.chat.reasoning.body` 只替换**展开区域**；`conversation.chat.reasoning.content` 是内容 Factory 槽 | 同上 |
| 因此：**没有任何现有接口**能让插件"只接管正文里的一个片段、其余仍走原生" | 结论 |

我们的 takeover 默认关闭正是因为这个限制；MiOpIIk 不声称"原生无损内嵌"已完成。

## 2. 最小接口设计（建议）

在 Markdown 渲染管线（`dsh-client-ui-primitives` 的 MarkdownText 或其上游）加一个**渲染器注册表**，
只把匹配到的 token/节点交给插件，其余照旧：

```ts
/** 嵌入组件：只拿到自己的节点，拿不到整条消息。 */
interface MarkdownEmbedProps {
  /** 解析后的 AST 片段（插件自定义，但必须是纯数据/JSON 可序列化） */
  value: unknown
  /** 原始文本，用于 fallback 与复制 */
  raw: string
  /** 宿主提供的运行环境（主题、链接策略、aria） */
  context: { mode: 'light' | 'dark'; locale: string }
}

interface MarkdownEmbedRegistration {
  /** 命名空间，冲突时明确报错而不是静默覆盖 */
  namespace: string
  kind: 'block' | 'inline'
  /**
   * 只匹配 fenced code block 的 info string（block）或行内 `{{ns:...}}`（inline）。
   * 不允许正则吞掉任意文本，避免误伤正常 Markdown。
   */
  match: (token: { lang?: string; info?: string; text?: string }) => boolean
  /**
   * 解析为受信数据；返回 null 表示"不接管"，交回原生 Markdown。
   * 解析失败必须返回 null 或 { error }，不得抛异常穿透渲染管线。
   */
  parse: (raw: string) => { ok: true; value: unknown } | { ok: false; reason: string }
  /** 渲染：只允许 React 元素/字符串，不允许 innerHTML/HTML 字符串/eval。 */
  render: (props: MarkdownEmbedProps) => React.ReactNode
  /** 解析失败/渲染异常时的降级文本（默认渲染 raw） */
  fallback?: (raw: string, reason: string) => React.ReactNode
}
```

注册入口（挂在现有插件上下文即可，不需要新插件类型）：

```ts
ctx.markdownEmbeds.register(registration): () => void   // 返回 disposer
```

### 兼容策略

- 未注册 → 行为与今天完全一致（fenced block 当代码块，行内保持纯文本）。
- 解析失败/渲染抛错 → **只降级该片段**，Markdown 其余部分与整条消息不受影响。
- 流式：片段未闭合时按普通文本显示，闭合后一次性 materialize（与今天的 `ink-view` 行为一致，不倒退）。
- 回放：注册表是纯前端能力，日志里存的是原始 Markdown 文本，因此历史消息天然可回放。
- a11y：嵌入组件必须自带语义角色；宿主只负责把 `aria-*` 与复制行为留给外层 Markdown 容器。

## 3. 变更位置（最小 PR 范围）

1. `dsh-client-ui-primitives`：`MarkdownText` 增加可选的 `embeds?: MarkdownEmbedRegistration[]`，
   在 AST → React 的节点映射里先问一次 `embeds`，未命中走原逻辑。
2. 同包新增类型文件 `types/client/markdown-embeds.d.ts`（上述接口）。
3. `dsh-client-ui-chat`：把插件的注册表经 context 透传给 `MarkdownText`（它已在渲染正文与 reasoning）。
4. 不改 `conversation.chat.node`、不改 `ReasoningRow`、不改日志事件。

**关键验收**：装上插件后，原生 reasoning 折叠、复制、图片、流式、回放零变化；只有被 `match` 命中的片段换成本插件组件。

## 4. 迁移阶段（与 MiOpIIk P0–P3 对齐）

| 阶段 | MiOpIIk 侧 | DSH 上游 |
|---|---|---|
| A（已完成） | 独立 IUI 节点 + 「视图」页实验预览；正文接管默认关 | — |
| B（本提案） | 接入 `markdownEmbeds`，删掉对 assistant-step 的接管依赖 | 提供第 2 节接口 |
| C | 模型默认生成 miopiik-ml；旧七 Widget 退居兼容 | — |
| D | 删除旧 `ink_view` 生成路径与死代码，保留只读 adapter | — |

## 5. 在此期间 MiOpIIk 的自我约束

- 正文接管**默认关闭**，且只作为实验开关；关闭时普通消息 100% 走原生。
- 不宣称"原生内嵌已完成"；IUI 的正式入口仍是独立节点/视图页。
- 行内混排（badge/link/code）先在我们的 IUI 容器内实现，等 B 阶段再进原生 Markdown。
