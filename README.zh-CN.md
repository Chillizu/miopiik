# MiOpIIk Agent

<img src="icon.svg" width="96" alt="MiOpIIk icon">

**Version 0.1.1**（stable） | [English](README.md) | 简体中文

`MiOpIIk` = `Mi`(nd) + `Op`(erator) + `IIk`(ink)。把 Ink 藏在词尾，是因为它本来就是隐在中间的那一层。

`miopiik-dsh` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 host 侧插件。它把 DSH Web 里的一次会话变成一套有治理的 agent 会话：前台只有一个声音，中间只有一份账本，后台只有一层执行。它不渲染聊天消息，也不替代助手；它改变的是助手能记住什么、能派发什么、能对外提交什么。

**当前发布：** 0.1.1（stable）。未发布到 npm registry；请从 GitHub Release 的 tarball 或本地 `npm pack` 安装。

## 它是什么

常规的「对话助手 + 工具调用」一旦遇上长耗时或跨回合的工作，往往只能二选一：要么阻塞当前对话让用户干等，要么把任务丢去后台从此失联；要是再引入一个中间管事的角色直接对用户开口，又很容易抢话、编造结论，跟主对话打架。

MiOpIIk 的做法是把「对话、记账、干活」拆成三层，并且只给其中一层发言权：

- **Mind** 是对话主干，也是唯一面向用户的角色。负责讨论、权衡、做决定、推进叙事；所有悬而未决的事（开环）只由它亲手闭合，对外提交的改动也由它向用户发起提议。
- **Ink** 是退在幕后的外置记忆与编译器。每轮过后，它把原话与回复收进上下文，从中提炼候选结论与未闭开环，维护分层收件箱，盯着后台任务有没有超时卡死，并在话题切换或跨天时准备折叠与交接素材。它永不直接对用户开口，也不替对话做决定。
- **Operator** 是执行层。它不拿整段聊天记录，只接手一份完整契约加一份鱼骨切片（分叉前提、原话引用、依赖事实卡）。干完之后通过 `ink_report` 交回结论或失败原因，不在对话里露面。

于是系统里同时流动着两条时间线：前台对话是一串连续的 turn 序列，后台执行是一串异步的 job 序列，由中间的 Ink 负责把两边的账对齐。**对话不被后台打断，后台也不必借对话证明自己。**

这也是它不是普通 chat assistant wrapper 的原因：插件提供的是章程、窄工具面、append-only 账本、后台派发和给界面用的 projection；对话仍然归 Mind 所有。

![架构：一个对话，两条时间线，三层分工](docs/images/report-2026-11-10/architecture.png)

上图是仓库里的真实架构图。下方「附加层：Extra」属于历史：这一层已经退役并归档到 [miopiik-extra](https://github.com/Chillizu/miopiik-extra)，当前的展示层是独立的 MiOpIIk IUI 插件。上方才是本 Agent。

## MiOpIIk Agent 与 MiOpIIk IUI

两个插件是彼此独立的包，各自可以单独安装，互不依赖。

| | MiOpIIk Agent（`miopiik-dsh`） | MiOpIIk IUI（`miopiik-iui`） |
|---|---|---|
| 定位 | host 侧 agent：Mind / Ink / Operator | 纯表现层 |
| 当前版本 | 0.1.1（stable） | 0.1.0-rc.4（prerelease） |
| 仓库 | https://github.com/Chillizu/miopiik | https://github.com/Chillizu/miopiik-iui |
| 依赖另一个插件 | 否 | 否 |
| 可单独安装 | 是 | 是 |
| 渲染什么 | 不渲染聊天；提供工具、prompt 上下文、会话功能页与右栏面板 | Markdown 中的声明式 `iui` 块与行内 token，由浏览器侧渲染 |
| 写入哪里 | 工作区下的 append-only JSONL 账本 | 不写日志；仅在浏览器 `localStorage` 存一个渲染偏好 |
| 宿主要求 | DSH Web（web profile） | DSH Web（web profile）；聊天内联渲染另需实验性 chat 包补丁 |

一句话：**IUI 是可选的展示，Agent 才是干活的核。** 只装 Agent，就得到完整的 Mind / Ink / Operator 机制和 Agent 自带的后台面板；当纯文字不足以表达比较、趋势或本地交互时，再装 IUI。IUI 不会变成事实来源，Agent 也不会重新内嵌一套自己的 UI 协议。

更早的 Extra 展示层只作为历史归档保留在 [miopiik-extra](https://github.com/Chillizu/miopiik-extra)。它的数据没有被删除：旧的 `ink-view` widget 快照在账本里仍然可读，IUI 的只读 legacy adapter 可以把它们回放出来。当前 Agent 不再产生新的 widget 记录。

## 架构与数据流

实现在 `host/`，浏览器侧在 `client.js`，插件入口在 `index.js`。

一个 turn 在系统里的流向：

1. **观测。** 回合结束时，Ink 机械地把用户真人提示与助手最终消息记进 `observations.jsonl`。只收人类可见的输入与助手最终文本，不碰思维链。
2. **编译。** 若 `conversationCompile` 打开，Ink 读自己的中间层上下文与近段原话，产出候选 note：一行结论、一个用户可回答的问题、置信度、证据，以及矛盾标记。
3. **投递。** note 变成分层收件箱里的预览（T0 阻塞、T1 连着活跃开环或分支、T2 新结论、T3 其余）。收件箱是编译产物抵达 Mind 的漏斗；说不说、什么时候说，仍由 Mind 决定。
4. **行动。** Mind 通过 `ink_*` 工具改账本：登记或闭合开环、写带出处的事实卡、开鱼骨分支、丢草稿，或走提交门对外提案。
5. **派发。** `ink_dispatch` 校验六要素契约，开一条 `pending-dispatch` 开环与一个后台 job，挂上分支切片，拉起 Operator 子 agent。子 agent 拿到的是契约与切片，不是对话。
6. **交回。** Operator 用 `ink_report` 交回结论（一条 claim 加证据，落成事实卡），或用自己的最终报告交回。Ink 把报告编译成预览，矛盾时标到具体那句 `U-n` 原话，送进收件箱。守夜机制把卡住与超时变成 T0 阻塞预览。
7. **折叠与交接。** 话题切换推进 epoch；长上下文分两阶段折叠；一天收工时可以由 Mind 亲手写五段式简报。检测到隔夜断点时，第二天开工先承认断点，而不是悄悄跳过。

每轮的 prompt 上下文（L3）由活跃开环与收件箱预览装配。它是 prompt context，不是聊天记录：Ink 的索引不会作为 user 或 assistant 消息进入消息流。

### 账本布局

所有状态都是工作区下的 append-only JSONL。文件名的依据是 `host/store.js` 的 `LOG_NAMES`。

```
<workspace>/.dsh/miopiik/
  sessions/<sessionId>/
    observations.jsonl    facts.jsonl        loops.jsonl
    notes.jsonl           inbox.jsonl        jobs.jsonl
    drafts.jsonl          cases.jsonl        branches.jsonl
    folds.jsonl           briefings.jsonl    details.jsonl
    ink-context.jsonl     ink-debug.jsonl    widgets.jsonl
    details/<hash>.txt
  shared/
    facts.jsonl
```

| 账本文件 | 记录内容 | 写入方 | 读取方 |
|---|---|---|---|
| `observations.jsonl` | 逐回合观测：用户真人提示、助手最终消息、回合边界、折叠 | Ink | 编译、折叠、所见面板 |
| `notes.jsonl` | 决定账与编译出的候选 note | Ink | 收件箱投递、审计视图 |
| `loops.jsonl` | 开环操作：`create` / `touch` / `status` / `close` / `drop` | Mind（经 `ink_loops`）；用户干预命令 | L3 上下文、收件箱关联 |
| `facts.jsonl` | 事实卡操作：`add` / `revise` / `invalidate`，带出处与作用域 | Mind（经 `ink_facts`）；Operator（经 `ink_report`） | L3 上下文、自答校验 |
| `inbox.jsonl` | 已投递预览及其状态：`read` / `star` / `unstar` / `defer` / `supersede` | Ink | L3 上下文、所见面板 |
| `jobs.jsonl` | 后台派发契约、子会话 id、任务状态与停止原因 | Ink / Operator 层 | 守夜巡检、任务板、所见面板 |
| `drafts.jsonl` | 提交门之下的草稿，含过期 | Mind（经 `ink_draft`） | 提交门、所见面板 |
| `cases.jsonl` | 判例：问题、答案、引用 | Ink | `ink_ask` 引用路径 |
| `branches.jsonl` | 鱼骨分支：前提、原话引用、依赖事实、汇回结论 | Mind（经 `ink_branch`） | 派发切片、所见面板 |
| `folds.jsonl` | 两阶段折叠提案、验收结果、应用记录 | Ink | 折叠验收、所见面板 |
| `briefings.jsonl` | 跨天交接简报与硬断点记录 | Mind（经 `ink_brief`） | 次日 L3、所见面板 |
| `details.jsonl` | 详情索引：内容 hash、实体、挂在开环/分支/job 上的指针 | Ink | `ink_recall` |
| `ink-context.jsonl` | Ink 自己的中间层上下文：尾部条目与头部折叠 | Ink | 编译 |
| `ink-debug.jsonl` | 留作审计的调试记录 | Ink | 诊断 |
| `widgets.jsonl` | 已退役 Extra 层写入的历史展示 spec；只读回放 | （仅历史数据） | IUI 的 legacy adapter |
| `shared/facts.jsonl` | 同一工作区所有会话共享的 workspace 级事实 | Mind（`ink_facts` 传 `scope: "workspace"`） | 所有会话 |
| `details/<hash>.txt` | 按内容 hash 寻址的详情正文 | Ink | 带 hash 的 `ink_recall` |

账本是纯文本，可肉眼审计。打开时逐个回放 JSONL；坏行跳过，不会拖垮整次回放；读时迁移不重写磁盘文件。

### 工具面

模型可见的工具面是刻意收窄的：Mind 占十二个，Operator 占两个。

| 工具 | 归属 | 用途 |
|---|---|---|
| `ink_status` | Mind | 读取后台状态：开环、事实、收件箱计数、epoch、day |
| `ink_loops` | Mind | 开环的 `list` / `get` / `add` / `touch` / `close` / `drop` |
| `ink_facts` | Mind | 事实卡的 `list` / `add` / `revise` / `invalidate` |
| `ink_inbox` | Mind | 收件箱的 `list` / `open` / `read` / `star` / `unstar` / `defer` |
| `ink_dispatch` | Mind | 把契约完备的工作交给后台 Operator |
| `ink_commit` | Mind | 打开唯一的对外提交门 |
| `ink_brief` | Mind | 跨天简报的 `materials` / `save` / `latest` |
| `ink_epoch` | Mind | 推进话题 epoch |
| `ink_draft` | Mind | 草稿的 `list` / `add` / `drop` |
| `ink_branch` | Mind | 鱼骨分支的 `list` / `open` / `get` / `summary` / `context` / `merge` / `abandon` |
| `ink_fold` | Mind | 上下文折叠的 `propose` / `review` / `approve` / `reject` / `list` |
| `ink_recall` | Mind | 检索详情索引；按 hash 读回一份详情 |
| `ink_ask` | Operator | 向 Ink 提问；Ink 只凭引用回答，否则上报 |
| `ink_report` | Operator | 交回一条带证据的结论，落成事实卡 |

这个分界是结构性的，不是提示词约定。`index.js` 里 Operator 子 agent 被 deny 掉十二个 Mind 工具，Mind 被 deny 掉 `ink_ask` 与 `ink_report`。Operator 子会话也拿不到聊天记录。用户还可以在界面上直接闭合开环或标废事实卡，这条路径不经过模型：它对应 `/miopiik loop close L-1`、`/miopiik loop drop L-1`、`/miopiik fact invalidate F-1` 会话命令与相应按钮。

## 主要能力

- **不是待办表的开环。** 一条开环是 Mind 与用户之间仍悬着的一句话：未答之问、等待用户、待选方案、口头承诺、待派发、半成形意图。没有日期，没有指派人。开环按天轴老化：`dormantAfterDays` 天后休眠，`foldedAfterDays` 天后折成一行，被 touch 唤醒。闭合权只在 Mind；Ink 最多提示「这条看起来被答了」。活跃上限（`activeLoopCap`）保证 prompt 上下文不被撑爆。
- **带出处的事实卡。** 敲定的结论连同来源、置信度、有效期和作用域一起落盘：默认只对本会话生效，需要其他会话也遵守时用 workspace。用户亲口说的事实高于 Operator 推断。Mind 需要凭记忆作答时必须引用事实卡或判例；引不出来就上报，不临场编造。
- **鱼骨分支。** 一件事从哪句话长出来，就在那句上开一条分支（`B-n`），记录分叉前提、主干原话引用和依赖事实 id。Operator 只拿这份切片，因此后台 agent 不会拿整段对话跑偏。工作有结论后，分支带着一行 claim 与证据汇回主干。
- **草稿区与唯一提交门。** 没底的工作先放草稿区，`draftExpireDays` 天没人碰自动丢弃，永不触达用户。对外改动一律走 `ink_commit`：一句话标题、一句话影响，用户只需回答「行」或「不行」。低置信改动在门口就被拒、留在草稿；本轮没有真人输入也不允许提交。被拒即结算为 rejected，绝不反问用户「你想怎么改」。
- **编译线与矛盾指认。** 符合条件的回合结束后，Ink 从自己的上下文编译候选。当后台结果与 Mind 对用户说过的旧话相抵触时，编译线会把它标出来，并指名具体那句 `U-n` 原话。何时坦白、怎么更正由 Mind 决定，Ink 不改写历史。
- **后台派发与守夜。** 派发前强行校验契约：目标、交付物、验收标准、验收样例、边界、预算；缺一项就拒绝并列出缺项，让不成熟的设想留在对话里继续聊。`draft: true` 的探索态只要求一句话目标，产出留在草稿区。任务运行期间，「跑着但没有新观测」（`operatorStallMs`）由卡住守夜捕获，超时（`operatorTimeoutMs`）由超时守夜捕获；两者都只投递 T0 阻塞预览，不替 Mind/用户做回滚决定。
- **两阶段折叠。** 折叠由事件驱动，不是字数硬截断。Ink 先做影子折叠：档案与开环结算建议，先不替换任何东西。仍握着旧上下文的 Mind 来验收，唯一判据是「折叠之后每条仍活跃的开环还接得上」。通过后应用叙事折叠；宿主提供压缩服务时排到下一个回合边界执行，没有就只记账，绝不偷偷改上下文。
- **跨天简报。** 一天收工时由 Mind 亲手写五段：推进、开环、在跑、草稿、下步打算。机器代写的简报会让明天的 Mind 认不出今天的自己，所以 Ink 只提供素材（`ink_brief materials`），L3 上下文展示最新简报与检测到的硬断点。前一天没告别就断了线，第二天开工先承认断在哪里。
- **看得见的后台。** 会话功能页「MiOpIIk」里有鱼骨图、分支 stream，以及列出活跃开环、事实卡、在跑任务、草稿与当日交接记录的清单；「所见」标签展示 Ink 的折叠头部、活跃尾部与刚编译出的候选。右侧栏「Ink」面板展示开环计数、收件箱预览与最近决定。幕后的一切都对用户开放，只是 Ink 不开口。
- **插件介绍/配置页与只读默认值。** 在 DSH 的 `插件 -> 已安装 -> MiOpIIk` 下，插件声明一个配置 slot，内含两个标签：介绍（三层、职责、版本、账本位置）与配置。配置页只读列出每个 host 可调项的内置默认值和可复制的 profile YAML 示例，不写任何文件；实际生效值以 profile 为准。
- **append-only 账本与回放。** 重启 DSH 即回放会话账本；状态不只活在模型上下文里。agent 自己的上下文只是账本之上的一份工作索引，不是事实来源。
- **历史兼容。** 旧会话账本不迁移、不改写、不删除。旧 widget 条目仍然可读，独立的 IUI 插件可以只读回放它们；当前 Agent 不再产生新的 widget 条目。

## 示意用法

下面的示例是示意的对话。**工具名与参数名都是 `host/tools.js` 里的真实名称，只有用户措辞是编的。** 每个示例都写清：用户说了什么，Mind 做了什么，系统产生了什么。

### 1. 一条会改变后续判断的事实

**用户：**「这个仓库用 pnpm，别在这里跑 npm install。」

**Mind：** 记事实卡，而不是靠自己硬记。

```json
{"action": "add", "claim": "This repository uses pnpm; do not run npm install here.", "provenance": ["user: turn 12"], "conf": "high", "source": "user", "scope": "session"}
```

**系统：** 卡片追加进 `facts.jsonl`；下一轮的 L3 上下文带上它；之后的回答引用这张卡。若用户后来改口说 pnpm 已弃用，Mind 修订或标废这张卡，而不是悄悄忘掉。

### 2. 一条留在对话里的问题

**用户：**「设置页到底保留原始 YAML 示例，还是有个复制按钮就够了？」

**Mind：** 登记一条开环，不强求当场拍板，继续聊。

```json
{"action": "add", "text": "Decide whether the settings page keeps the raw YAML example or only the copy button", "type": "pending-option", "pointer": "turn 18", "closureCondition": "The user picks one and the page copy reflects it"}
```

**系统：** `loops.jsonl` 多一条 `create` 记录。若用户在三个回合后给出答案，Mind 用准确 id 闭合：

```json
{"action": "close", "id": "L-7", "reason": "user chose the copy button only"}
```

Ink 可能提示过「这条看起来被答了」，但执行闭合的只可能是 Mind。

### 3. 一份带真实契约的后台任务

**用户：**「把报告翻成英文，做完之前顺手把测试跑一遍。」

**Mind：** 先开分支，让这项工作能追溯到这句话，再用完整契约派发。

```json
{"action": "open", "label": "report-translation", "summary": "Deliver an English report and a green test run", "forkedAtTurn": 34, "premise": "The user wants the existing report translated and verified in one background pass", "quotes": ["Translate the report to English and run the test suite before you're done."], "facts": ["F-4"]}
```

```json
{"goal": "Translate the report to English and run the test suite", "deliverables": "An English report file plus the test run output", "acceptance": "The English report exists and the test suite exits 0", "acceptanceSample": "A short English report; a test summary with no failures", "boundary": "Do not change the report's conclusions or the source code", "branch": "report-translation", "budget": "One background pass, no network access"}
```

**系统：** 一条 `pending-dispatch` 开环、一条 job 记录、一张任务板卡片，以及一个 Operator 子 agent。子 agent 看到的是契约与分支切片，不是对话。干完后交回结论：

```json
{"claim": "The English report is complete and the test suite passes", "conf": "high", "evidence": "docs/report.en.md; test run exited 0"}
```

Ink 把结果编译成收件箱预览；Mind 用 `ink_inbox {"action": "open", "id": "I-6"}` 打开，用 `ink_branch {"action": "merge", "id": "B-3", "claim": "English report delivered; tests green", "detail": "docs/report.en.md"}` 汇回分支，再决定怎么告诉用户。若契约缺项，`ink_dispatch` 会直接拒绝并指出缺了什么。

### 4. 提交门与一天收工

**用户：**「把设置页文案缩短那版发出去，但发之前问我一声。」

**Mind：** 先把工作停在草稿区，再打开唯一的提交门。

```json
{"action": "add", "title": "Shorter settings page copy", "summary": "Replace the configuration page text with the shorter version", "artifact": "docs/draft/settings-copy.md", "conf": "mid"}
```

```json
{"title": "Settings page copy", "summary": "Shorter configuration text; no behavior change.", "confidence": "high", "draftId": "P-3"}
```

**系统：** DSH 只问用户一个问题，选项是 行 / 不行。「行」把草稿结算为 committed；「不行」结算为 rejected，不会追问用户要怎么改。低置信提交在打扰用户之前就被拒。

一天收工时由 Mind 亲手写交接：

```json
{"action": "save", "progress": "Settings copy shortened and shipped", "loops": "L-7 closed; L-9 still waiting on the release decision", "running": "No background jobs running", "drafts": "None", "next": "Start from the release decision, not from a summary of the day"}
```

**系统：** 简报落进 `briefings.jsonl`，出现在下一次会话的 L3 上下文与后台面板里。如果那天没告别就断了，第二天开工先报告硬断点再往下接。

## 运行要求与支持范围

| 项 | 要求 |
|---|---|
| 宿主 | DSH Web（`web` profile）；host 侧插件，不是独立应用 |
| DSH 基线 | 0.2.1-rc.5（测试与发布检查所针对的版本） |
| Node | >= 23.6（`package.json` 的 `engines`） |
| 运行时依赖 | 无；包没有任何第三方运行时依赖 |
| 浏览器侧 | `client.js` 声明 `platform: "web"`，接入 DSH 的会话视图、右侧栏与 `plugins.bundle.config` slot |
| 其他平台 | 未验证；插件依赖 tools、system prompt、session projections、subagents、user questions、compaction 等 DSH Web 服务 |

DSH 本身在演进。上面的基线是本版本验证过的版本；升级 DSH 可能重命名或移除插件依赖的宿主服务。兼容性以 `docs/SUPPORT-MATRIX.md` 为准。

## 安装、升级、卸载、回滚

**本包没有发布到 npm registry。** 直接 `dsh plugin add miopiik-dsh`（不给路径或 tarball）解析不到，也不存在从 registry 安装的路径。请从 GitHub Release 的 tarball、本地 `npm pack`，或一个 checkout 路径安装。

### 从 GitHub Release 安装（推荐）

1. 从
   https://github.com/Chillizu/miopiik/releases/tag/miopiik-agent-v0.1.1
   下载 `miopiik-dsh-0.1.1.tgz` 与 `SHA256SUMS.txt`。
2. 在下载目录里用 `sha256sum -c SHA256SUMS.txt` 校验。
3. 用 `dsh plugin --profile <profile> add ./miopiik-dsh-0.1.1.tgz` 装进目标 profile。
4. 重启提供该 profile 的 DSH 进程。只刷新浏览器不够：host 插件在 DSH 进程启动时加载。

### 从本地 checkout 安装

仓库根就是包根（`package.json` 与 `index.js` 同级），且包没有依赖，所以不需要 `npm install`。

```sh
git clone https://github.com/Chillizu/miopiik.git
cd miopiik
npm pack
dsh plugin --profile <profile> add ./miopiik-dsh-0.1.1.tgz
```

`npm pack` 只在本地产出 tarball，不要发布到任何 registry。

也可以直接把工作树装进去（link 模式）：

```sh
dsh plugin --profile <profile> add /path/to/miopiik
```

辅助脚本 `tools/install-plugin.mjs` 封装了两种模式。默认 dry-run，打印将要执行的 `dsh` 命令；除非显式允许，否则拒绝写入正在使用的 `web` profile：

```sh
node tools/install-plugin.mjs --profile <profile>            # dry-run，link 模式
node tools/install-plugin.mjs --profile <profile> --mode tarball --execute
node tools/install-plugin.mjs --profile web --execute --allow-running-profile
```

### 升级

1. `dsh plugin --profile <profile> remove miopiik-dsh`
2. `dsh plugin --profile <profile> add ./miopiik-dsh-<新版本>.tgz`
3. 重启该 profile 的 DSH 进程。

### 回滚

1. `dsh plugin --profile <profile> remove miopiik-dsh`
2. `dsh plugin --profile <profile> add ./miopiik-dsh-0.1.1.tgz`
3. 重启该 profile 的 DSH 进程。

卸载、升级、回滚都不会动会话账本：账本在工作区里，不在插件目录里。新版本出问题就回滚到 0.1.1；0.1.1 的 tarball 是本次发布的稳定产物。

### 卸载

```sh
dsh plugin --profile <profile> remove miopiik-dsh
```

然后重启该 profile。对话历史仍留在工作区账本里；以后再装回来，插件会回放它。

## 配置

配置写在 profile 的 `cordis.patch.yml` 里，位于本插件的 `config` 段。patch 会整体替换该条目的 `config`；没写出的字段回落到下面的内置默认值。

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: miopiik-dsh
  config:
    stateRoot: .dsh/miopiik
    activeLoopCap: 12
    conversationCompile: true
```

默认值来自 `host/config-defaults.js` 的 `DEFAULTS`：

| 键 | 默认值 | 含义 |
|---|---|---|
| `stateRoot` | `.dsh/miopiik` | 账本目录（相对工作区） |
| `activeLoopCap` | `12` | 活跃开环上限；超出后按固定顺序折进休眠 |
| `dormantAfterDays` | `2` | 几天没被碰到就休眠 |
| `foldedAfterDays` | `7` | 几天后折成一行 |
| `draftExpireDays` | `7` | 草稿几天没人碰自动丢弃 |
| `briefingMaxChars` | `1800` | 交接简报的字数上限（一屏） |
| `inboxPreviewChars` | `220` | 每轮注入的预览总字数上限（不数条数，能塞几条塞几条） |
| `detailInlineMaxChars` | `1200` | 多长的详情转成指针（超过就落到详情仓） |
| `inkTailLimit` | `24` | 中间层上下文尾部保留多少条（超了折叠成头部） |
| `inkHeadMaxChars` | `2000` | 中间层头部摘要上限（字） |
| `operatorTimeoutMs` | `1200000` | Operator 超时毫秒数（20 分钟） |
| `operatorStallMs` | `360000` | 多久没有新观测算「卡住」（6 分钟） |
| `inkModel` | `null` | Ink 编译用的模型（`null` 表示跟随会话默认；否则为带 `provider` 与 `model` 的对象） |
| `conversationCompile` | `true` | 回合结束后让 Ink 读自己的上下文并产出候选（`false` 表示只记账不处理） |

`插件 -> 已安装 -> MiOpIIk` 下的插件设置页会列出这些内置默认值与可复制的 YAML 示例。它只读，显示的是默认值而不是当前实际运行值；实际生效值以 profile（以及更高层 patch）解析结果为准。

## 安全与权限

- **只有一个写入位置。** 插件只写工作区下的账本根目录（默认 `<workspace>/.dsh/miopiik`，或配置的 `stateRoot`，仍相对工作区）。它不写 DSH 安装目录、profile 目录或任何其他用户目录。
- **append-only、可肉眼审计。** 账本是纯文本 JSONL，不加密，也没有自动脱敏：对话里说过的东西可能被观测日志原样保留。把对话当成会落盘的内容，不要往里贴 secrets。
- **不采集凭据、无遥测。** 插件没有凭据字段，不会把环境变量或 DSH 凭据文件写进账本。它不读环境变量里的 secrets，代码里没有任何网络请求或分析埋点。它自身对外流量为零；模型调用走宿主配置的 LLM 服务（Ink 编译用 `ctx.llm`，Operator 用宿主的 subagent 服务）。
- **角色结构分离。** Operator 子 agent 被 deny 掉十二个 Mind 工具，拿不到聊天记录，只拿到契约与分支切片。Mind 被 deny 掉 Operator 专用的 `ink_ask` 与 `ink_report`。这由 `index.js` 的 per-agent 工具限制强制执行，不靠提示词自觉。
- **提交门属于用户。** 对外改动通过 `ink_commit` 提案，用户只需回答「行」或「不行」。低置信被拒、无真人输入的回合不能提交、被拒即结算草稿且不追问用户怎么改。界面上的按钮是提议不是授权：插件不会把渲染出来的控件当成用户同意。
- **后台输入按不可信处理。** 编译输出只当数据解析，不执行。编译失败或格式异常会降级成带原始报告附件的预览，绝不编造结论。
- **尊重发言权。** Ink 不对用户说话，只投递预览与提示；展示什么、什么时候、用什么措辞，由 Mind 决定。

## 测试与开发

```sh
npm test            # node --test
npm run check       # tools/check-release.mjs
npm run build:check # tools/build-client-rules.mjs --check
npm run icon:check  # tools/icon-check.mjs
```

| 命令 | 检查什么 |
|---|---|
| `npm test` | 用 Node 内置 test runner（`node:test`）跑单元与集成测试，无第三方测试依赖 |
| `npm run check` | 发布就绪检查：必需元数据、真实 `npm pack`、解包文件清单对运行时 import 图、每个随包脚本 `node --check`、图标规则、包体积上限。输出 JSON 报告，有问题即非零退出 |
| `npm run build:check` | 若 Agent 客户端重新引入已退役的 IUI / Widget 渲染器则失败。独立的 IUI 包是唯一的界面渲染来源 |
| `npm run icon:check` | 校验随包 `icon.svg` 是否符合图标规则（SVG、不超过 256 KiB、无脚本或外部引用、36x36 viewBox）以及 `exports["./icon"]` / `files` 元数据；可选 `--original <path>` 与设计原稿逐字节比对 |

测试套件设计为在干净 checkout 里通过：不需要装 DSH、不需要 `~/.dsh`、不需要 Chromium、不需要网络。需要真实宿主的能力会跳过或按条件执行，而不是假装通过。包没有第三方运行时依赖，跑测试前没有东西要装。

CI：`.github/workflows/ci.yml` 在 push 与 pull request 上跑上面的命令。

贡献者需要知道的仓库结构：

| 路径 | 内容 |
|---|---|
| `index.js` | host 插件入口：会话初始化、projection、工具注册、章程 |
| `host/` | 引擎、账本、编译、折叠、派发、Operator、工具面 |
| `client.js` | 浏览器侧：会话功能页、右栏面板、插件页 |
| `SPEC.md` | 架构规格与不变式（单一真源） |
| `test/` | `node:test` 测试套件 |
| `tools/` | 发布检查、图标检查、客户端渲染器防复活、安装辅助、开发脚本 |
| `docs/` | 设计记录、审计、历史报告、架构图 |
| `locale/` | 插件文案字典 |

关键文档：

- [SPEC.md](SPEC.md)：架构规格与不变式，单一真源。
- [docs/ALIGNMENT-AUDIT.md](docs/ALIGNMENT-AUDIT.md)：与最初设计对话的对齐审计。
- [docs/SUPPORT-MATRIX.md](docs/SUPPORT-MATRIX.md)：DSH/Node 支持基线与已知限制。
- [LICENSE](LICENSE)：MIT 许可证文本。

## FAQ

**它和 MiOpIIk IUI 是同一个东西吗？**
不是。Agent（`miopiik-dsh`）是干活的核：Mind / Ink / Operator、账本、派发、提交门。IUI（`miopiik-iui`）是独立的展示插件，渲染声明式 `iui` 块。两个可以单装也可以同装，互不依赖。

**装完需要重启 DSH 吗？**
需要。host 插件在 DSH 进程启动时加载；要重启目标 profile 对应的进程，只刷新浏览器不够。

**数据在哪？**
在工作区的 `.dsh/miopiik/`（或配置的 `stateRoot`）下：每会话账本、workspace 级事实、详情仓。纯文本 JSONL，升级、回滚、卸载后都还在。

**能不能只用 Agent，不装 IUI？**
可以。Agent 不渲染聊天 UI，也不依赖 IUI；它自己的后台面板与插件页在没装 IUI 时照常工作。

**拆分之后，旧会话还在吗？**
在。会话账本不迁移、不删除。旧 widget 快照仍然可读；装了 IUI 的话，其只读 legacy adapter 可以回放。本仓库不承诺旧 widget 条目还能再编辑。

## 局限

这份清单不粉饰。

- **没有 npm 发布。** 分发形式只有 GitHub Release tarball、本地 `npm pack` 或 checkout；没有可作为依赖的 registry 包。
- **仅 DSH Web。** 插件针对 `web` profile 与 DSH 0.2.1-rc.5 构建和测试。其他宿主、profile、DSH 版本未验证，宿主 API 漂移可能直接弄坏它。
- **非官方插件。** 不由 DeepSeek Harness 项目维护，依赖的宿主服务不构成稳定性承诺。
- **没有性能与规模基准。** 没做负载测试、大账本基准、成本测量。打开 `conversationCompile` 时，符合条件的回合会多一次 LLM 调用；每次派发都是一个额外的后台 agent；预算请自行计入。
- **没有 secrets 扫描。** 账本按原样保留对话文本；插件不检测、不脱敏 secrets。
- **旧展示数据只读。** 旧 widget 快照被保留且可回放，但当前 Agent 不产生新的 widget 记录，也不编辑旧的。
- **依赖宿主服务。** 提交门需要宿主的 `userQuestions` 服务；折叠应用需要宿主的 compaction 服务。缺前者时提交门打不开，缺后者时折叠只记账、不落到上下文。
- **不是第二个助手。** Ink 不回答用户；插件不自动提交、不自动外发、不无人值守地执行对外动作。

## 仓库拆分

本仓库是原 MiOpIIk monorepo 的延续，旧仓库仍在 https://github.com/Chillizu/miopiik。Agent 包从 monorepo 里的子目录上移到仓库根；git 历史与既有 tag、Release 都保留。

展示插件被提取到独立仓库 https://github.com/Chillizu/miopiik-iui，有自己的历史与自己的 prerelease 线（当前 0.1.0-rc.4）。更早的 Extra 展示层归档在 https://github.com/Chillizu/miopiik-extra。会话数据不在仓库之间迁移，仍然留在上面说的工区账本里。详细映射见 [docs/MIGRATION.md](docs/MIGRATION.md)。

## 贡献

Issue 与 Pull Request 走 https://github.com/Chillizu/miopiik。

- 保持拆分边界：Agent 仓库不得重新内嵌 IUI 渲染器（`npm run build:check` 会守住这条）。
- 沿现有风格：Node ESM、相对导入、零第三方运行时依赖、host 代码没有构建步骤。
- 测试放在 `test/*.test.js`，用 `node:test`；PR 合并前测试必须绿。
- 本地跑 `npm test`、`npm run check`、`npm run build:check`、`npm run icon:check`。
- 架构或数据模型改动应在同一次改动里更新单一真源 `SPEC.md`。
- 不要把打包产物或缓存提交进仓库；`.dsh/` 已被忽略。

## License

MIT。见 [LICENSE](LICENSE)。

Copyright (c) 2026 Chillizu。
