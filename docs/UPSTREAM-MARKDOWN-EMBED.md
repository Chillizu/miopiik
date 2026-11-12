# 上游提案：Markdown 受信嵌入扩展点（草案 v1）

> 状态：**接口已在本机实验分支落地**（未启用、默认关闭），上游 PR 尚未提交。作者：MiOpIIk Extra 层。
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

## 6. 本机实验分支（已实现，未启用）

### 6.1 真实依赖树结论（2026-11-12 核对）

| 项 | 事实 |
|---|---|
| `profiles/web/node_modules/@deepseek-ai/dsh-client-ui-chat` | 符号链接到全局安装：`…/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat`，v0.2.1-rc.5，**只有 `lib/`（打包产物）+ `lib/types` + `locale`，没有 `src/`** |
| `dsh-client-ui-primitives` | 同一 profile 下的链接指向不存在的 `/opt/deepseek-harness/...`（已失配）；运行时由前端 bundle 提供，磁盘上**没有可修改的源码** |
| DSH Web 前端 | `/assets/index-*.js` 是预构建产物；chat 客户端插件以独立 `client.js` 由服务端加载 |
| 结论 | **无上游源码可构建**。因此不做"盲改全局包"，改为"本地 fork 客户端插件 + profile 级替换"，可审计、可回滚 |

### 6.2 已交付内容

1. `tools/fork-chat-embeds.mjs`：把已安装的 `dsh-client-ui-chat` 复制到 `miopiik-dsh/upstream/dsh-client-ui-chat-embeds/`（生成物、不入库），
   只在 `AssistantMarkdown` 的 `case "text"` 分支插入一个挂钩，**其余与上游逐字节相同**；生成后 `node --check` 自检，并输出差异到
   `docs/upstream/chat-markdown-embeds.patch`（约 80 行，供上游评审）。
2. `shared/markdown-segments.js`：受信切分器（块级 ```iui 围栏 + 行内 `{{badge:success:文本}}` / `{{icon:check}}` / `{{code:x}}`），
   纯函数、可单测；未闭合/非法 token 原样保留。
3. MiOpIIk 客户端注册 `globalThis.__miopiikMarkdownEmbeds`（`segments` / `renderInline` / `renderBlock`），复用它自己的
   `IuiSheet` 与 `validateAst`；**不注册就不生效**。

### 6.3 关键性质

- **原生所有权不变**：`AssistantMarkdown`、`ReasoningRow`（折叠/摘要/流式/a11y）、图片、附件、复制、断点回放仍由 DSH 自己的组件负责；
  我们只替换 `text` 块里被受信 token 标记的片段。
- **默认关闭**：fork 挂钩先检查 `localStorage['miopiik.markdownEmbeds'] === '1'`；未开启时直接返回 `null`，走与上游完全相同的路径。
- **局部降级**：`segments` 返回 `null`、注册表缺失、`renderBlock/renderInline` 抛错，都只影响该片段（`data-miopiik-embed-fallback` 文本兜底）。

### 6.4 启用步骤（需重启，由 ChatGPT preflight）

**重要：只改 web profile 的覆盖链接，不动 `~/.dsh/profiles/node_modules/` 下的共享/全局包。**

```bash
# 1) 生成 fork（幂等；会自动重建 node_modules 依赖链接）
node tools/fork-chat-embeds.mjs

# 2) 在 web profile 专属目录加覆盖链接（不存在才建；不要动共享链接）
cd ~/.dsh/profiles/web/node_modules/@deepseek-ai
# 若该名称已被共享配置占用，先备份再替换
[ -e dsh-client-ui-chat ] && mv dsh-client-ui-chat dsh-client-ui-chat.bak
ln -s /home/data/Projects/Mio/MiOpIIk/miopiik-dsh/upstream/dsh-client-ui-chat-embeds dsh-client-ui-chat

# 3) 重启 dsh-web（由 ChatGPT 执行）
# 4) 浏览器控制台：
localStorage.setItem('miopiik.markdownEmbeds', '1'); location.reload()
```

**为什么需要 node_modules 依赖链接**：fork 目录是"另一个包"，Node 从它自身向上解析依赖，
不会继承 DSH 安装树；缺少链接时 `lib/index.js` 会报
`ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery`，插件 import 失败导致聊天不可用。
生成器会在复制后创建 `fork/node_modules -> <DSH 安装>/node_modules`，并在 `--check` 时只读校验
（不删除、不重建）。

**回滚**（任选其一）：
```bash
# 彻底回滚
cd ~/.dsh/profiles/web/node_modules/@deepseek-ai && mv dsh-client-ui-chat.bak dsh-client-ui-chat
# 或只停用接管（无需重启）
localStorage.setItem('miopiik.markdownEmbeds', '0')
```

### 6.4.1 已实测（2026-11-12，ChatGPT 执行）

- fork 覆盖链接解析成功；服务 `active`，3080 返回 401（正常鉴权，未泄露凭据）。
- 隔离 headless Chromium（未复用用户 profile、未发新消息）中：`window.__miopiikMarkdownEmbeds`
  存在，分词结果为 `[text, inline, text, inline]`；页面 JS error = 0。
- 同一会话 64 个原生 `[data-variant=think]` 中，对首个 `[role=button]` 实际点击，
  `aria-expanded` 走 `false → true → false`，**原生 reasoning 折叠在 fork 开启条件下可用**。
- 首次启用时曾因缺依赖链接 import 失败，已回滚并修复（见上）。

### 6.5 尚未完成 / 风险

- 未在真实 3080 验证（需重启；本轮不自行重启）。
- fork 与上游版本耦合：升级 DSH 后若 `AssistantMarkdown` 结构变化，生成脚本会**直接报错**而不是产出错误补丁。
- 行内 token 若跨越 Markdown 结构（如 `**加粗 {{badge:x}} 继续**`），两侧文本会被分别渲染，加粗会在 token 处断开——这是切分式嵌入的已知限制，改用 remark 插件可彻底解决（上游 PR 方向）。
- 流式期间未闭合 token 按普通文本显示，闭合后一次性 materialize。
