# MiOpIIk Extra：展示层（Intelligent UI 风格）

> 创建：2026-11-06 | 状态：设计稿 v2，待定稿
> 定位：**附加层**。删掉这一层，MiOpIIk 照样成立。
> 不碰：两份日志、闸门、L3 预算、开环/事实的数据形状、用户词表。
> 配图：[extra-ui.html](diagrams/extra-ui.html)（可交互，含规格 [extra-ui.architecture.json](diagrams/extra-ui.architecture.json)）

---

## 0. 一句话

把「讨论里需要看一眼就懂的东西」从纯文本升级成**一个 IR + 几个投影**：模型交数据与意图，投影决定长相。不引入第二套设计系统，不让模型自由生成界面。

---

## 1. 一个 IR，多个投影

**IR（中间表示）**：`records + fields + relations + 可选 axis`。一切都先变成这个形状。

**投影**：同一份 IR 的不同呈现方式。新需求 = 新投影，不改模型约定。

```
spec（数据 + 意图） → IR → 投影选择（数据形状 + 能力清单） → 展示面（卡片 / 抽屉 / 导出）
```

| 投影 | 吸收 | 覆盖 |
|---|---|---|
| `dataset` | table + chart | 对比、账本、审计、矩阵；柱/线/环/散点 |
| `graph` | flow + timeline + 鱼骨 | 流程、因果、状态转移、时序、分叉与汇回 |
| `text` | — | 解释、结论、证据链、兜底 |
| `choice` | — | 确认、闸门，≤2 个动作 |
| `media` | — | 图片、文件、沙箱 HTML（逃逸） |
| `layout` | — | 组合容器：stack / row / grid，嵌套 ≤2 层 |

**九个渲染器合并成五个投影**：组件更少，能表达的场景反而更多。鱼骨不再需要专用渲染器——它是 `graph` 的一个配置（双轴 + 分叉/汇回 + 泳道），主视图与 Extra 共享同一份 IR 与同一份投影，只是交互不同。

---

## 2. 三档自由度（选 / 组 / 逃逸）

| 档 | 形态 | 信任 | 何时用 |
|---|---|---|---|
| 选 | 一个投影 + 结构化 props | 最高，可回放 | 默认路径 |
| 组 | `layout` 容器拼多个投影 | 高，仍受 schema 约束 | 预设表达不了、但仍是结构化内容 |
| 逃逸 | 沙箱 iframe 内的 HTML（`media`） | 最低，标记不可信 | 一次性产物：需要真交互，或数据形状根本不像上面任何一种 |

默认绝不进逃逸档：HTML 换来的自由度，代价是回放、主题、无障碍、跨客户端降级——而 MiOpIIk 的核心资产恰好是「回放能重建」。

---

## 3. spec 形状

```json
{
  "widget": "dataset",
  "v": 1,
  "props": {
    "title": "两种接入方式",
    "columns": [{ "label": "维度" }, { "label": "自绘组件" }, { "label": "内核节点" }],
    "rows": [["改动面", "客户端插件", "chat 包"], ["上线成本", "低", "高"]]
  },
  "fallback": "自绘组件改动小、上线快；内核节点能力全，但要动 DSH。"
}
```

- `widget` 选投影；`props` 由该投影的 schema 校验；`fallback` 必填。
- 组合用 `layout` 包一层，子项仍是同样的 spec。
- **spec 是数据，不是像素**：落进观测日志的是上面这段 JSON，可回放、可导出、可审。

---

## 4. 硬规则（违反即拒绝渲染）

1. **`fallback` 必填**，且必须能独立读懂——导出 Markdown、老版本客户端、渲染失败全靠它。
2. **未知 widget 报错并列出可用清单**，不静默降级成空白。
3. **交互只走既有通道**：卡片上的动作只能变成一次工具调用或一条 session command，不许直接改账本状态。
4. **样式只许用设计 token**：颜色、字体、间距、圆角由主题给，spec 里不允许出现 CSS。
5. **一张卡只放一个决定**：多层级、多视图的东西不进卡片，留在抽屉里（SPEC §6 判据三问）。
6. **降级链只往下走**：任意投影 → `text`。不允许失败后「升级」成 HTML。

---

## 5. 覆盖率验证（2026-11-06）

从 `SPEC.md`、`docs/` 与本轮讨论抽 20 个「当时想用图说清」的样本：

| # | 样本 | 出处 | 形态 | 落点 |
|---|---|---|---|---|
| 1 | 十二不变式 | SPEC §1 | 列举 | `text` |
| 2 | 阶段表（批次/内容/状态） | README | 进度矩阵 | `dataset` |
| 3 | 三种折叠的触发与产出 | SPEC §5.1 | 对比 | `dataset` |
| 4 | 开环六种 | SPEC §4.3 | 分类 | `text` |
| 5 | 开环生命周期 | SPEC §4.3 | 状态转移 | `graph` |
| 6 | 派发链路 | SPEC §4.1/§4.4 | 流程 | `graph` |
| 7 | 收件箱 T0–T3 分层 | SPEC §3.3 | 优先级层次 | `dataset` |
| 8 | note 的 kind 枚举 | SPEC §2.2 | 枚举 | `dataset` |
| 9 | 自审计 56 / 37 / 8 | SPEC §11.2 | 数值 | `dataset`（chart） |
| 10 | 判例 C-1 与 J-4 | SPEC §11.3 | 证据链 | `text` |
| 11 | L0–L5 缓存前缀 | SPEC §4.6 | 层次 | `dataset` |
| 12 | 交接简报五段 | SPEC §5.3 | 结构化文本 | `text` |
| 13 | 天轴老化 | SPEC §5.6 | 时间序列 | `graph`（axis） |
| 14 | 闸门 accept / reject / settle | SPEC §4.1 | 状态转移 | `graph` |
| 15 | 审计发现 → 修复 | SPEC §11.2 | 对比 | `dataset` |
| 16 | 旧账本迁移事故 | SPEC §11.4 | 因果事件 | `graph`（axis） |
| 17 | 单测 78 项分布 | SPEC §11.3 | 数值 | `dataset`（chart） |
| 18 | 两种接入方式对比 | 本轮讨论 | 对比 | `dataset` |
| 19 | MiOpIIk 三层架构 | README | 结构示意图 | `graph` |
| 20 | 鱼骨双脊 + 分支汇回 | 交互界面 | 双轴 + 分叉 | `graph`（泳道 + axis） |

**结论**：20/20 落得下。鱼骨不再落不下——它是 `graph` 的一个配置。`chart` 的真实样本仍少（2 条），保留观察。

---

## 6. DSH 落地路径（按代价排序）

1. **客户端插件渲染**（第一版）：spec 从工具结果回到客户端插件，先渲染在抽屉/侧栏。只动 `miopiik-dsh/`，不碰内核，出问题核心照样跑。
2. **内联到对话流**：需要 DSH 开放「插件注册节点种类 + 渲染器」的公开席位。节点类型表（`ChatNodeDataMap`）已是合并面，渲染注册目前看是 chat 包内部 keyed seat，需向 DSH 确认设计意图后再动。
3. **逃逸档**：沙箱 iframe，默认关，显式开启并标记不可信。

---

## 7. 验收

- 每条 spec 都能 `fallback` 成纯文本，且导出 Markdown 后语义不丢。
- 回放同一份日志，渲染结果结构一致（主题可不同）。
- 删掉 Extra 包，核心测试全过、对话主流程不受影响。
- 一次对话里出现 ≥3 种投影仍不显得花——这条靠人看，不靠断言。

---

## 8. 非目标

不做任意 HTML/CSS；不做导航；不做第二套设计系统；不做用户可编辑布局；不做「模型生成组件代码」。

## 9. v1 落地（2026-11-08）

- 入口：`ink_view`（show / list / clear），spec 经 `host/widgets.js` 校验后落 `widgets.jsonl`；
- 渲染：MiOpIIk 页新增「视图」页签，支持 dataset（表格 + 可选条形）、graph（按 lane 分列 + 边表）、timeline、text、choice、media、layout；
- 硬规则已生效：fallback 必填、未知 widget 报错列清单、choice ≤2 动作、layout 嵌套 ≤2；
- 未做：交互（v1 只读，选择回到对话）、自由 HTML 逃逸档、对话流内联。

### 9.1 实机验证（2026-11-08 晚）

- `ink_view show` 连放三份 spec（表格 / 时间线 / 泳道图），`ink_view list` 读回正常；
- 「视图」页签渲染通过（截图：[extra-view-live.png](screenshots/extra-view-live.png)、[extra-view-live-2.png](screenshots/extra-view-live-2.png)）；
- 待做：`choice` 的点击回传（走 session command）、把「流水」「所见」也换成同一套渲染器。

### 9.2 内联进对话流（2026-11-08）

找到了 DSH 的公开接缝：`tool.call.toolview` 是按**工具名**键控的席位（契约原话：“Keyed Tool call view dispatched by wire Tool name. Any name is allowed, including tools registered by your package.”）。

因此 `ink_view` 的调用可以直接在对话流里渲染成卡片，而不是躲在「视图」页签：
- 注册：`ctx.slots.register({ name: 'tool.call.toolview', key: 'ink_view' }, InkViewRow)`；
- 数据来源：工具调用的 `argsRaw`（含 spec），不新增会话事件；
- 渲染：复用 `renderWidget`，卡底仍显示 fallback。

这比“自定义 chat node kind + 会话事件”那条路便宜得多，且不碰内核。

实机验证（2026-11-08 20:57 重启后）：卡片直接长在对话流里，标题、表格与卡底 fallback 文本齐全 —— [inline-widget-fixed.png](screenshots/inline-widget-fixed.png)。
坑记一笔：`result` 阶段原始参数在 `block.call.argsRaw`，`start` 阶段在 `block.argsRaw`；只读 `block.args` 会解析成空、退化成占位文案。

### 9.3 卡片站进正文（2026-11-09）

§9.2 的 toolview 席位能渲染，但它在**过程组**里——回合结束就跟着「思考块」一起折叠。用户要的是卡片站在正文对应位置。

换到更靠里的接缝：Conversation 业务定义。

- 注册一个 `target: 'chat'` 的 Definition（`ctx.uiConversation.events.register`），`kind: 'miopiik-widget'`；
- `match` 只认 `tool/call` 且 `data.name === 'ink_view'`，spec 从 `data.arguments` 里解析（本来就是落盘日志里的调用参数，不新增事件）；
- `buildViewNode` 的 `anchorSeq` 取调用事件的 seq（+0.2 排在工具行之后），`groupTree: 'turn'`。

`groupTree: 'turn'` 是关键：Chat 的过程组只收「过程层」的节点（`isAtOrOutside(node, 'process')` 为假才进 pending），Turn 层节点会在分组时先 flush 再单独成行，于是卡片落在调用处、不被折叠。

渲染仍走同一套：`ctx.slots.register({ name: 'conversation.chat.node', key: 'miopiik-widget' })`。旧的 toolview 席位撤掉，免得同一张卡在折叠区里重复出现。

实机验证（2026-11-09 21:51，重载后）：卡片独立成行，`data-chat-flow-kind="miopiik-widget"`、无 `data-turn-process-member` —— [inline-widget-body.png](screenshots/inline-widget-body.png)。
结构上它不会再被折叠：过程组只收 `isAtOrOutside(node,'process')` 为假的节点，而 `groupTree: 'turn'` 的深度是 2，判真。

七种形式一轮走完（2026-11-09 21:56，都在对话正文里）：dataset 表格、graph 分列+边表、timeline、text、choice、media 链接、layout(row 组合) —— [extra-forms-all.png](screenshots/extra-forms-all.png)。
粗糙处两条：`graph` 的边只是下面的小字表；`choice` 现在还是只读的两行，没有按钮样子。

### 9.4 真图表化（2026-11-09 晚）

上一版被指「错位、不直观、没有真正图表化」。改了三件事：

- `graph` 换成 SVG：节点按 lane 分列，边画成带箭头的曲线；前向边走字段间隙的横线，回边从盒子底部偏侧绕过整列、走图底再回来；边名不再堆在图上，收成图下一行小字图例。同列节点竖直相连。
- `dataset` 的 `chart` 分成三种：`bar`（HTML 柱，数值在上、标签在下，宽度自适应）、`line`（SVG 折线 + 点 + 数值）、`donut`（SVG 环 + 右侧色块图例）。
- `timeline` 改成竖向轨道：时间列定宽右对齐，轨道一条线加圆点，最后一项高亮；`choice` 的选项改成单列卡片；`dataset` 表格首列定宽、`tableLayout: fixed`；`layout` 的 row 用等宽 grid。

验证走了离线预览台（`.dsh/harness/`，同一份 renderWidget 抽出来在无 React 环境里渲染），比每次重启快得多；然后页面刷新即生效——`rev` 是内容指纹，换代码刷新就拿到新包，不必重启服务。
实机截图：[extra-charts-live.png](screenshots/extra-charts-live.png)。
仍粗糙：卡片上仍挂着那条 fallback（应当只在渲染不了时出现）；一轮里多张卡堆叠的问题（B-1）没动。
