# MiOpIIk 规格（一页纸）

> 状态：架构闭合，可实施 | 版本：0.1 | 2026-11-04
> 本文件是设计的单一真源。实现细节在 `README.md` 与 `miopiik-dsh/`；规格与实现的偏差必须在此文件「实现偏差」一节明文记录，不得静默改规格。

---

## 0. 命名

| 层 | 英文名 | 代号 | 职责 |
|---|---|---|---|
| 对话主干 | **Mind** | M | 叙事权威、注意力、派发判断、commit 提议 |
| 中间层 | **Ink** | I | 编译、校验、记账、收件箱、折叠、判例、守夜 |
| 执行层 | **Operator** | O | 普通 agent，可递归；原 O/T 合并，不再有独立 T |

**MiOpIIk 读法**：`Mi`(nd) + `Op`(erator) + `IIk`(ink)。Ink 藏在词尾——因为它本来就是隐身的那个层。

一句话：**用户始终只与 Mind 交流；Ink 把行动编译成对话能消化的东西；Operator 在后台干活。**

---

## 1. 十二不变式

1. 用户永远只跟 Mind 说话；Ink 与 Operator 不面向用户。
2. 两份日志不互写：观测只由 Mind/Operator 写，决定只由 Ink 写。
3. 双鱼骨 = 同一份 append-only 日志的两个分辨率视图；共享节点 ID，不复制内容。
4. Ink 永不阻塞、永不等候；所有「问」都是入队决定，标 pending 继续做别的。
5. 主动的终点是收件箱；能打断对话的只有 Mind 的注意力。
6. 自答必须带引用（事实卡/判例编号），无引用即上报。
7. 闸门按 **commit** 计，不按动作计；闸门只要求判断、不要求修理；低置信不 commit。
8. Mind 的工具面只有对话级 + 委派/查询/召回；长程执行能力不在 Mind 手上（结构强制，不靠 prompt）。
9. 派发门槛：Mind 能用一句话复述目标 **且** 说出「完成是什么样子」；说不出就继续聊。
10. 无人值守不 commit；任何用户输入都唤醒 Mind。
11. 结构上硬，判断上软：规定只保留结构（schema/容量/通道），行为策略交给可见信号 + 留痕。
12. 无损存储，有损上下文。

---

## 2. 数据模型

### 2.1 观测日志

会话事件（用户消息、助手最终消息、工具结果、turn/end、compaction），append-only，主要由 Mind 推、Operator 填。
每个事件带单调序号 + `epoch` + `day`（并发到达靠它判过期）。

### 2.2 决定账（note）

Ink 做过的每个操作。

**必填**：`claim`（脱离上下文也读得懂的一句话状态增量）+ `why`（理由码 + 一句话）+ `refs`（证据指针）。
**`kind` 决定其余字段**：
`absorb`（看了、判定无需理会；最便宜的一条，只填 claim + why，是全表唯一能解释「当时为什么没动」的依据）/ `preview` / `answer` / `ask` / `hold` / `verify` / `fold` / `escalate` / `drop`。
**可选**：`supersedes`、`stale_after`、`visible_to_user`（审计「它到底瞒了多少」）、`conf`（low/mid/high，**不用数值**，数值会被调着玩）、`loops[]`、`detail`（详细记录 + 内容 hash，存盘不进上下文）。

**粒度 = 一次决定**。判据：这条不写，三周后说不清「当时为什么这么做」。
**hash 只能取回，不能检索** —— 必须另建按实体/时间/开环可查的索引；provenance 在写入时挂好，不事后找。
**note 是状态增量，不是日记**：变了什么、证据指针、置信、牵动哪条开环。日记会增长，增量会组合。
**判决缓存**：同一 claim 验过一次，判决本身是 note，第二次直接引用，不再取 detail。
**detail 保留期必须长于引用它的 note**；只要还有 note 指着，detail 不能删，否则 provenance 断链。

### 2.3 Mind 的三份记忆

| | 形状 | 增长 | 谁维护 |
|---|---|---|---|
| 叙事 | 按时间的故事，被折叠压缩 | 长 | Mind |
| 开环 | 无序小集合，有上限 | 频繁增删 | Mind（Ink 只能建议） |
| 事实卡 | claim + provenance + 失效条件 | 只增不删，可标失效 | Ink |

**工作记忆 = 当前叙事窗口 + 全部开环 + 相关事实卡。不是聊天记录。**

### 2.4 判例

Ink 回答 Operator 的每个判断与答复都留痕，可被后续检索引用。同一类问题第二次直接引判例——一致性 + 可审计。

### 2.4b 鱼骨分支

主干是对话；**分支从对话的某个节点分叉**（记下当时的 `turn` 与事件序号），承载一个或多个任务，最后把结论**汇回主干**。

- `B-n` + 名字 + 一句话摘要（由 Mind 写，可更新）+ `forkedAtTurn` + 状态（open/merged/abandoned）；
- **上下文切片**（让分支真的能独立推进）：`premise`（分叉处的前提，Mind 用自己的话写）+ `quotes`（主干原文引用，不改写）+ `facts`（依赖的事实卡 id）。切片只增不补：引用与事实只增，前提可改写且历史留在日志。派发时把切片给 Operator——它拿到的是**这一段工作需要的前提**，不是整个对话；`ink_branch get` 让 Mind「进分支里看」。
- 分支不是任务：任务是「谁在干」，分支是「这件事从对话哪一句长出来的」；
- **汇回 = 一条带分支指针的预览**，不是往对话里塞结论；
- 预览的「连接点」因此有两种：一条开环，或一条分支——两者都算「连着对话节点」（§3.3 规则相应放宽）。

### 2.5 草稿

未达 commit 门槛的产物，带过期时间。Mind 可自行 commit 到草稿区（不落盘、不外发、可整体丢弃）。

### 2.6 交接简报

收工折叠的产物，五段，见 §5。

---

## 3. Ink 的机制

### 3.0 中间层的上下文（ink-context）

Ink 有自己持续存在的上下文，不每轮从磁盘重算——「常驻的是它的上下文，不是它的注意力」。

- **追加**：每回合把用户原话、Mind 的最终回复、**Ink 自己做过的判断（note）**、Operator 交回的事实推进尾部；条目带 `U-n` / `F-n` / `D-n` 引用，正文压成单行（≤200 字）。
- **折叠由事件驱动**：话题 epoch 前进、收工信号、跨天开工时折叠；容量（尾 ≤24 条 ×2、头 ≤2000 字）只作护栏，不是触发器。折叠是确定性的（不编造），产出记 `reason`。
- **观测流不进上下文**：`observations.jsonl` 是全量台账（含工具结果、回合边界），只用于规则判定、`ink_recall` 检索与回放；进入模型的是这条上下文，以及按需检索出来的片段。

### 3.1 编译

- 把 Operator 的产物变成人能读的材料：去术语、留证据、标置信。
- **详细 note 进 detail 层，brief 层只留决定 + claim + 指针。**
- 关于 Operator 的 note 必须从**产物**生成，不能从 Operator 自述生成（自述会污染账本）。
- **两级翻译**：第一级知识翻译（去术语、留证据）由 Ink 做；第二级处境翻译（放进当前语境、语气、时机）只能由 Mind 做——它需要知道用户在想什么。
- **对话编译**：回合结束后 Ink 读自己的上下文（近段对话 + 活跃开环 + 活跃事实），产出 `claims / loops / closedLoops` 候选（各上限 3；开环只用 §4.3 六型；closedLoops 只认活跃开环 id；conf 可选，缺省视为未标注）。**没有出处（U-n）不产**；解析不出来或没有东西可产时返回 null，不投降级预览。**出口分两路（2026-11-21 修订：原为收件箱预览）**：模型自标 `conf:"low"` 的结论不静默落账，逐条投收件箱过目（低置信闸门）；未标注与 mid/high 照旧**静默吸收**——落事实卡（`source: ink`、相近去重、可 `supersedes` 失效旧卡），只记一条 `kind: absorb` 的 note，不占收件箱待读位；疑似已解的开环只挂 `suggestedClose` 提示，闭合权仍在 Mind。开关 `conversationCompile`（默认开，热生效），模型沿用 `inkModel`（空=继承会话）。细节与佐证见 §13.1。

### 3.2 自答 / 上报

判据是机械的出口检查，不是分类器：**能引用就自答，要发明就上报。**

- **自答**：共享状态里已有（事实卡 / 判例 / 用户已声明）→ 引用式答复
- **上报 Mind**：要改方向、与已声明事实冲突、对外部有影响
- **Mind 再问用户**：改目标、扩范围、不可逆外部影响

「机械」的部分是**产出格式**（必须带引用），不是思考过程；它可以想得多自由都行，出口只有一个带证据的门。

### 3.3 收件箱 = Mind 的手机

不是任务面板，不是用户 UI。三区：**未读 / 历史 / 星标**。

- **实时提示不是系统弹窗**，是回合边界的一次「看一眼」，以对话内插入动作的形式呈现（「等一下，我看了眼后台」）。
- 三个动作：**展开 / 已读 / 压后台**。全部是 Mind 的动作，不产生用户可见事件。
- **星标** = 跨天记忆的显式标记；比开环轻、比事实卡重，不占未读位，每次开工都被带上来。
- **排序用分层视图**（不用加权公式，人是这么读收件箱的，公式会产生反直觉倒挂）：
  - T0 阻塞（需要用户或 Mind 一句话才能继续）
  - T1 命中活跃开环
  - T2 新结论（推翻旧结论 / 改了方向）
  - T3 其余 → 折叠成一行计数
- **默认视图，不是硬管**：Mind 可看全量。
- 结构约束（不是时机规则）：每条预览必须连着一个对话节点——**开环、分支，或它引用的那段话（U-n）**；都指不上自动降 T3（相关性就是结构）；同一开环最多一条待读预览，后来的合并更新前一条（否则话多的分支能刷屏）；epoch 不匹配标 stale 降一级。
- **每轮注入按字符预算**（默认 220 字）：能塞几条塞几条，不数条数；挤不下的显示「还有 N 条」。这是默认视图，不是硬管——Mind 可要全量。
- **预览 = 状态 + 与当前话题的连接点 + 一个问题**；软目标一行（30–40 字），硬上限两行；「挤不下」本身是信号——说明该拆成两条，或者它其实是 detail。
- **结尾那个问题 = 命中的开环改写成疑问句**——所以「自然融入」是查表，不是判断。
- T0 与 T2 的先后由用户定；默认阻塞优先（阻塞会腐烂，结论不会）。

### 3.4 守夜

超时或连续无进展的 Operator 视为卡死 → 生成 `[阻塞]` 预览。无判例可依的挂起，不猜。

### 3.5 偏差与阻塞

优先级 **回滚 > 打补丁**。回滚该 Operator 的全部动作后判废；改**契约**优先于改提示词；修环境优先于重试；新会话重开。判废记录进判例库（「这条路走过、不行」）。

---

## 4. Mind 的机制

### 4.1 闸门

**只有一次对外闸门，绑在 commit 上。** commit = 一个用户只能「接受 / 拒绝」的整体改变。

- 草稿区之外一律要用户点头。**批准权归用户；Ink 与 Operator 没有；Mind 只有提议权**（否则闸门被内部消化）。
- **闸门只要求判断，不要求修理。** 每个 commit 必须一个词就能被拒；拒绝后系统自己收拾（丢弃或重做），不能反问「你想怎么改」。
- **commit 门槛 = 「我确信会被接受」，不是「勉强能用」。** 不达标的留在草稿区自动老化消失。**「做了一半」对用户的伤害大于「没做」。**
- **准确性在派发时决定，不在 commit 时检验。** 契约 = 交付物 + 验收标准 + **验收样例**（「大概长这样」——给你看标准你要翻译一遍，看样例只要说像不像）+ 边界 + 预算。
- **早期形状检查**：Operator 开工后尽快交粗样（大纲/方案/第一屏），Ink 验一次。早期偏差是唯一值得打扰人的偏差；晚了，偏差已经长进产物里。
- 偏差根治靠**缩短回路**（反馈延迟），不靠加验证：**验产物、不验过程**。盯过程既贵又招人烦，且盯得再紧也挡不住理解偏差。
- **可逆性只挡大错，挡不住「半对半错」**——用户对半对的东西不会去修，会「凑合吧，能用就行」，偏差就固化了。所以默认宁可不交付。
- **无人值守不 commit（结构强制）**：`ink_commit` 先检查本轮有没有真人的输入；没有（夜间、自动续跑）直接拒绝，只允许留在草稿区。闸门不会因为没人看着而松开。

### 4.2 纠错

Mind 说过的每句话也是带 provenance 的 claim。Operator 的结果与旧话冲突时，Ink 能发现（它有账本和 utterance 链接），但纠正必须由 Mind 挑时机主动说（「顺便说一句，之前那个我说错了」）。
没有这个机制，账本越准，对话越不可信——因为两套事实在打架。

### 4.3 开环

**不是待办**：没有日期、没有 owner、没有状态机。它是**对话里悬着的东西**，六种：

1. 未答之问 —— 用户问了，Mind 没答完就被岔开
2. 用户未答 —— Mind 问了，用户还没回
3. 悬置选项 —— 桌上摆着 A/B/C，没收敛
4. 承诺 —— Mind 说过「回头讲 / 我记着」
5. 待转正派发 —— 草稿在跑，等用户一句话
6. 半成形意图 —— 用户在往某个方向走，但没到能派发的程度

一条 = 一句话 + 指针（哪轮 / 哪个分支 / 哪张事实卡）+ 闭合条件。

**生命周期**：回复时顺手登记（不是额外动作）→ 话题 epoch 前进就老化（降权、折叠，不删）→ 命中实体复活 → 闭合（被回答 / 被放弃 / 转任务 / 用户明确不要了）。

- **闭合权只在 Mind**，Ink 只能提示「这条看起来被答了」。
- **用户不可见**：一旦可见，它就是任务面板，会吃掉 Mind 的注意力。
- **遗忘是显式动作**，不是被动发生。
- 活跃开环进上下文，上限约 12；休眠开环进账本、不设限。超限按固定规则折叠（最近没命中的先折、最老的先折），不让模型自由裁量。
- 用户主动丢弃可以静默；若用户之后提起被丢的，Mind 现场重建。

### 4.4 派发

没有意图分类器。判据是**可验收性自检**：Mind 能不能用一句话复述目标，并且说出「完成是什么样子」。

- 写不出来 → 继续聊。
- 过早派发的真正成本不是算力，是**用半成品理解替换了用户的图景**，之后所有产出都叠在这个偏差上。
- 正式派发留一句复述（用户不反对就走）；**草稿态免门槛**，因为可丢弃。这就是「不过度主动」和「不用事事下令」的边界：**不看预算，看可逆性**。

### 4.5 展示

- **不设阈值、不设每日次数。** 信号（回复变短、确认型回复、停顿、话题耗散、直接问进展）只作为**可见信号**给 Mind，判断交给它。
- 形态是**提议不是倾倒**：「对了，我做了个东西，你要不要看？」——用户只付一个字，**误判的代价必须由 Mind 承担**。
- 时机是**话题能量低点（间隙），不在话题中段**。同一个动作在间隙是接话，中段是打断。
- 长尾漂移的解不是加规则，是**让 Mind 自己的行为进它的记忆**：收工折叠时「一次都没展示」「连续三条没看」会出现在简报里，它会自己说「昨天我一件都没给你看，是不是太闷了」。

### 4.6 上下文与缓存

缓存按前缀命中，所以按**变化频率从低到高**排，可变性只放尾部：

L3 之外，Mind 还能从 L3 末尾看到一行鱼骨：「B-1 定位验证：确认假设是否成立（2 个任务（1 完成 / 1 在跑），从第 7 轮分叉）」。

```
[L0] 人格与规则                        基本不变       常驻缓存
[L1] 已折叠的叙事档案                   仅折叠时变     缓存边界
[L2] 叙事尾部（append-only）            每轮追加       前缀稳定
[L3] 开环全量 + 收件箱预览               每轮可变       尾巴
[L4] 本轮用户消息
[L5] 按需检索的事实卡                    点开才进
```

- 折叠是唯一会打断缓存的常规动作 → 必须稀疏、事件驱动、一次摊薄。
- **账本是数据，上下文只是索引。**
- 鱼骨天然适合前缀共享：分支 fork 继承主干前缀，边际成本极低。
- Mind 能看见余量，并可以把这件事说出来（「我先把这段收一收」「这个再展开我怕接不住，先记下来」）——压缩从后台清理变成对话的一部分。

---

## 5. 折叠与跨天

### 5.1 三种折叠，一套机制

| 折叠级别 | 触发 | 产出 |
|---|---|---|
| 话题折叠 | epoch 结束 | 档案 + 开环结算 |
| 收工折叠 | 一天结束 | 加上交接简报 |
| 长缺席折叠 | 多日未归 | 日简报再折成周简报 |

折叠 = **叙事折叠 + 开环结算**（闭合删 / 存活改写 / 转任务移出 / 丢弃显式记）。中间层自己的上下文（§3.0）同一套触发：epoch 前进 / 收工 / 跨天时折，容量只作护栏。
**验收判据：折叠后每条开环都必须接得上**；接不上就补事实卡或改写开环。压缩要保住什么，由开环决定，不为「保住全部信息」而摘要。
**两阶段**：Ink 影子折叠 → **仍持有旧上下文的 Mind 验收** → 原子替换；不通过重做，别将就。

### 5.2 收工

- **有告别**（「先这样」「明天再说」「我去忙了」）：Mind 折叠，对用户最多一句。
- **无告别**（直接关掉）：不假装无缝——下次开工先做事后折叠，并承认「上次我们聊到一半就断了，我接着那半句说」。断点被承认，比被抹掉更像人。

### 5.3 交接简报

**由 Mind 自己写**，Ink 只递四样素材（今日事件流、在办任务状态、草稿清单、开环快照）。理由：机械生成的简报会让第二天的 Mind 认不出自己。

```
[交接 11-03]
推进：三分结构定稿；双日志；三层存根；闸门下沉到 commit。
开环：展示时机未定；note 字段表还没写。
在跑：O-7 竞品扫描（形状样例已过，预算 60%）；O-9 卡死，待判废。
草稿：定位方案 B（置信中，边界没碰，缺你的偏好输入）。
下步：想先聊展示时机——它可能是"填入间隙"而不是"打断"。
```

- 一屏内；超过一屏就是没折好，该重新折。
- **「下步」不能省**：它是 workmate 和助手的区别——Mind 对明天该干什么有自己的意见，当然可以被用户覆盖。
- 支持**追加**「隔夜更新」，不覆盖原句（能看到自己当时怎么想、后来变了什么）。

### 5.4 隔夜三不变式

1. **无人值守不 commit**：夜里只产出草稿，任何落盘/外发都等用户在场。闸门不因为没人看着就松开。
2. **Ink 永不直接回复用户**，哪怕凌晨三点。任何用户输入都唤醒 Mind，Mind 从简报 + 当前状态重建。代价是几秒重建，换来「用户始终在跟同一个 Mind 说话」。
3. **不能自答的挂起，不猜**：没有判例、没有事实卡的，标 pending 等 Mind；宁可第二天问，也不夜里替用户做决定。

### 5.5 开工

先读，不先说：简报 → 收件箱（按 salience）→ 活跃开环 → 需要时再取事实卡。

**开场最多提一件事**：
- 有隔夜成果 → 提最相关的那件（「昨晚那个跑完了，结论有点意思」）
- 没有 → 自然的招呼 + 一条未闭合线索的引子
- 用户第一句直接开新话题 → 立刻跟随，简报留到后面用

最糟的开场不是沉默，是「昨夜完成了 3 项任务，其中 1 项失败」——那是仪表盘人格。

### 5.6 天轴老化

- 开环：当天活跃 → 隔 2 天休眠 → 隔 1 周折成一行
- 草稿：隔夜保留，一周没碰自动丢弃（丢弃时简报记一笔）
- **用户自己做的成果进账本，来源标「用户」，权威高于 Operator 的任何推断**——Mind 不该重新推导用户已经想明白的事

---

## 6. 产品面

**判据三问**：服务用户判断吗？用户能低成本干预吗？会不会变成不看的负担？
三问过不了就不做——**没有可操作性的页面会退化成仪表盘，仪表盘会退化成焦虑**。

| 面 | 结论 |
|---|---|
| 悬着的事（开环用户视角） | **做**。可划掉、可说「这个不要了」 |
| 我们一起定的（事实卡） | **做，优先级最高**。纠错成本最低：对话里说「你理解错了」Mind 要重新理解，事实页划掉一条系统直接改；用户对「我们一起定过什么」比对进度更在意 |
| 后台在跑（分支状态） | 不做整页，做**抽屉** + 极轻存在感指示（内容不必看，存在感有必要） |
| 存在感指示放哪 | **会话顶栏右侧工具位**（`conversation.session.header.utilities`），与计划任务/日志下载同级。不放输入框下方——那是遥测区（token 数、上下文占用），语义不同且贴输入区易误碰；不放左侧栏——侧栏是全局导航，碰「不做导航栏」的忌 |
| note / 决定账 / 判例 | 不做产品面，做**审计**（藏深、定位为取证） |
| 所见（Ink 的上下文） | **做，只读**：折叠头 + 尾部 12 条 + 对话编译候选；不交互、不做成导航。它是「它读到了什么」的唯一可见面，与「流水」（它判断了什么）成对 |
| 入口有几个 | **一个主入口 + 一个常驻面板**：`MiOpIIk` 页（鱼骨 / 清单 / 流水）是主视图；**右侧栏有 Ink 常驻页签**（`ctx.sidebarRightTabs.register({ kind: "miopiik" })` + `sidebar.right.pane.tab` 席位 + `ctx.sidebarRight.openTab`），从 MiOpIIk 页的「在右侧栏打开」进入。窄屏页签区分鱼骨与清单，宽屏并排 |
| 画布宽 | 上限 780 并居中；宽屏不再把两条脊拉到没法连线 |
| 执行层怎么画 | 右脊上的**方块**=Operator 任务（10px，在跑实心品牌蓝、完成半透明绿、失败/卡住空心红），标签 `J-n 状态 · 任务名`；圆=Ink 自己的动作（分叉/汇回/放弃） |
| 鱼骨长什么样 | **双脊时间线**。左脊=对话轮次、右脊=后台事件；两条脊用 DSH 品牌蓝（`--dsw-static-deepseek-500`）加粗，**只有它们用主色**。通信线用中性色（实线=派出去，虚线=收回来），悬停时提亮。Ink 侧事件画圆，**执行层（Operator）画方**，形状表示层、颜色表示状态（蓝=在跑、绿=完成、红=失败/卡住、灰=其他）。顶部有「看示例」开关，用合成数据把全部分支状态与任务状态一次铺出来，不写账本 |
| 草稿架 | 后置，可选（看 / 丢 / 继续） |
| 每天的交接信 | 后置，可选（它管「关系」，不管判断） |

**两条容易被忽略的规则**：
1. **不做导航栏**。次级视图都从对话里长出来（覆盖层）：点 M 提到的一条结论 → 打开那条事实；点存在感指示 → 打开抽屉；收工时看一眼那封信。用户永远不离开对话——这是唯一能挡住「后台面板引力」的做法。
2. **内部术语不外泄**。用户词表（严肃语域，2026-11-04 修订）：**未结事项 / 已定结论 / 运行中 / 草稿 / 交接记录**。动作词：关闭、标记失效。开环、note、账本、分支、epoch 是内部词，词表错了产品就露馅。

---

## 7. 明确否决过的选项（防重蹈）

| 否决 | 原因 / 替代 |
|---|---|
| 独立 T 层 | O/T 同构，O 只是根任务的调度视图；合并进 Operator |
| 双 M | 无法同步；改为外置大脑 Ink（只共享状态，不共享推理） |
| 意图分类器 | 读心式判定必翻车；改为可验收性自检 + 草稿态 |
| 数值置信度 | 会被调着玩；改 low / mid / high |
| 发明事实语言 | 过于复杂；改为「必须带引用」的出口格式 |
| 全局单闸门 | 会变成硬性条件；改为按 commit 计 |
| 可逆性当安全网 | 只挡大错，挡不住半对半错（用户不修） |
| 过程监视 | 贵、招人烦、挡不住理解偏差；改验产物 |
| 展示阈值与每日次数 | 没有信息量；改可见信号 + 留痕 + 自我审计 |
| 用户可见任务面板 / 导航栏 | 后台面板引力会吃掉注意力 |
| Ink 直接回复用户 | 破坏「用户始终在跟同一个 Mind 说话」 |
| 无人值守 commit | 闸门不能在无人时松开 |
| 生成式摘要当记忆 | 会漂移；改事实卡（claim + provenance + 失效条件） |
| 把 note 做成管理页给用户 | 用户看不懂且没必要；改审计视图 |

---

## 8. 失败模式

1. 简报越长越差——超过一屏就是没折好。
2. 隔夜结果与简报冲突——追加修订，不覆盖原句。
3. 一周不在——日简报先折周简报再开工，开环批量结算，否则恢复成本比重新聊还高。
4. 会话中途硬断——不假装无缝，承认断点并事后折叠。
5. Operator 自述污染账本——只信产物，不信自述。
6. 过早派发——用半成品理解替换用户图景，之后所有产出叠在偏差上。
7. Ink 长成第二个 M——权限边界：不改目标、不改优先级、不替 Mind 决定要不要说。

---

## 9. 术语表

| 内部 | 用户可见 |
|---|---|
| 开环 / open loop | 未结事项 |
| 事实卡 / fact card | 已定结论 |
| 分支 / 在跑的任务 | 运行中 |
| 草稿 | 草稿 |
| 交接简报 | 交接记录 |
| note / 决定账 / 判例 | 不出现（审计） |
| epoch / 折叠 | 不出现 |

---

## 10. 验收标准

1. 第二天开工，用户不用问「我们在干嘛」。
2. 用户说「继续昨天那个」，Mind 能精确说出停在哪一句，且没有重读记录。
3. 简报一屏内，且含 Mind 自己的下一步意见。
4. 隔夜零 commit、零主动噪音。
5. 一轮对话结束后，Ink 产出带开环指针的预览；下一轮 Mind 能看到并按规则决定是否展开。
6. 派发 → 编译 → 预览 → commit 闸门全链路成立；闸门一词可拒，拒绝后系统自己收拾。
7. 关掉再开：开环/事实/收件箱/简报跨重启存活。
8. 默认界面只有对话 + 一个存在感指示；两个页面从指示/对话长出来，无导航栏。

---

## 11. 实现偏差（不得静默修改上文）

> 本节记录「规格要求」与「当前实现」的差距，按批次推进收敛。每条都指明差距与后续批次。

### 11.0 数据卫生

- 过滤规则（只收 `source.kind=user`）上线前，goal 轮次与时间上下文曾被记为 `user`（3 条，第 18–19 轮）。
- 处理：**不改磁盘**（append-only 不动），在回放时按明确前缀规则改判为 `system`，标 `reclassified: legacy-user-injection`；这样「对话节奏」不会把系统提示当成用户说的话。
- 规则见 `store.js` 的 `SYSTEM_PREFIXES`；新增系统注入类型时要同步这里。

### 11.1 已确定的实现路径差异（不改变语义）

- **存储介质**：未用 `ctx.storageDomain`（`defineDomain` 需要 zod 运行时依赖，workspace link 的 bundle 解析不到 `@deepseek-ai/*`）。改为 `<cwd>/.dsh/miopiik/<sessionId>/*.jsonl`：append-only、可回放、无损、可肉眼审计。
- **会话投影**：未用 `ctx.sessionProjections`（同一 zod 依赖原因）。改为监听 `session/event` 写观测日志，重启回放恢复。
- **叙事压缩**：仍由 DSH compaction 负责；§5.1 的「Ink 影子折叠 → 持旧上下文的 Mind 验收 → 原子替换」尚未接入，列为 Batch 4 后续项。
- **commit 闸门留痕**：闸门通过 `ink_commit` 直接问用户（`ctx.userQuestions.ask`），不额外写 note；用户答复以工具结果留在会话日志（观测日志），符合「决定只由 Ink 写、观测由 Mind/Operator 写」。
- **守夜不执行回滚**：超时只投递 `[阻塞]` 预览并记 job 超时；中断/回滚留给后续批次。

### 11.2 自审计（2026-11-04，由 Operator 产出）

完整报告：[docs/audit-2026-11-04.md](docs/audit-2026-11-04.md)（56 条结论：19 条一致，37 条偏差；审计快照 HEAD `9f11ea4`）。

审计后已修复（对照 9f11ea4）：

| 审计发现 | 修复 |
|---|---|
| P0 `ink_brief` 未进 deny 列表（结构边界洞） | `INK_TOOL_NAMES` 已含 `ink_brief` / `ink_epoch`（引擎热重载前检查） |
| P0 存在感永远显示"安静"（count 无赋值点） | 客户端改为诚实的"后台"入口：只给存在感与可点开，不谎称运行状态 |
| §1.12 观测/detail 截断 4000 字 | 观测落盘上限 200k 并标记；编译 detail 存 Operator 全文（20k） |
| §2.1 无 epoch、无工具结果观测 | 观测带 `epoch`；记录 `tool` 结果摘要；`ink_epoch` 由 Mind 推进 epoch |
| §3.3 无"展开"动作、无三区 | `ink_inbox` 增加 `open`（取回 note detail）与 `zone=unread/history/starred` |
| §3.3 L3 预览缺问题 | L3 预览行带"→ 问题" |
| §4.1 低置信仍可 commit | `ink_commit` 增加 `confidence`，low 直接拒绝 |
| §5.5 L3 顺序（简报→收件箱→开环） | 已按规格排序 |
| §6 违反"不做导航栏" | 移除 `sidebar.panellist` / `main` 常驻入口，两个面改为抽屉内切换 |
| §6 两个面缺数据与干预 | session projection `miopiikBackstage`（Host 计算）wire 到客户端；按钮走 session command `/miopiik loop close` / `fact invalidate`。实测：L-3 由用户从界面关闭（`by:"user"`），`command/run`+`command/done` 留痕，F-1 在「我们一起定的」里显示 |
| §1.7 闸门缺收尾 | `ink_commit` 支持 `draftId`：批准 → 草稿 settle 为 committed；拒绝 → settle 为 rejected（不要求用户修理） |
| §2.5 无草稿区 | 草稿账本 `drafts.jsonl`、`ink_draft` 工具、7 天老化、简报素材真实草稿、抽屉「后台在跑」展示 |
| §5.3 简报无单屏校验 / 隔夜更新不可见 | 超过 1800 字拒绝重写；`ink_brief update` 追加隔夜更新，L3 逐条显示且不覆盖原句 |
| §5.2 硬断不承认 | 跨天且无收工简报时，L3 置顶要求「先承认断点」（事后折叠仍待） |
| §6 审计视图缺失 | 抽屉底部「取证」入口，展开最近 8 条决定账（藏深，不当产品面） |
| §2.4 无判例库 | `cases.jsonl` + 确定性匹配（Jaccard/覆盖率取最大）：事实卡命中 → 生成判例；同类问题第二次直接引判例 |
| §3.2 无引用式自答路径 | `ink_ask` 是 Operator 提问的唯一通道：能引用就自答（判例优先 → 事实卡），匹配不上以 blocking 预览上报 Mind，并让 Operator 按契约继续 |
| §3.4 无「连续无进展」 | 仍只有超时守夜（保留登记） |
| §4.2 纠错只有前置 | 编译时带上 Mind 最近说过的话（`recentUtterances`），报告与旧话冲突时标 `contradicts` → note 改「更正候选」+ `newConclusion`（T2），纠正的时机仍由 Mind 挑 |
| §5.2 硬断事后折叠 | 启动与跨天时 `detectGap`：上次真人对话停在旧的一天且无收工简报 → `foldDay` 整理盘外素材（推进/悬着/在跑/草稿）+ 记 `hard-break`，L3 当天置顶提醒「先承认断点」 |
| §4.2 纠错只有最近窗口 | 说过的每句话有稳定 id（`U-<seq>`），回放后不变；编译前按词面相关性把**较早**说过的相关句捞出来（确定性检索，不调模型），矛盾时指认是哪一句（`更正候选（U-12）：…`）。仍非全量语义索引，跨窗口的口语改写可能漏检 |
| §4.4 只有一条硬门槛 | `ink_dispatch` 支持 `draft: true`：只要一句目标就能跑；产出进草稿区（不进收件箱、不打扰用户）、开环自动收为 `draft:settled`。实测 J-7：结果落在 P-2，收件箱零新增 |
| §3.4 只有超时守夜 | 加无进展守夜（`shouldStall` 纯函数 + 定时检查观测序号）：任务还在跑、6 分钟没有新观测 → 投递 `[阻塞]`「看起来卡住了」，只报不杀；有产出即重置 |
| §2.2 详情只有全文和指针 | 详情仓落地（`host/details.js` + `details.jsonl` + `details/<hash>.txt`）：内容 hash 去重；note 超过 1200 字只留 120 字预览 + `detailRef`；索引支持关键词/实体/开环/分支/天数检索（`ink_recall`），hash 只负责取回；回收只删「无引用且超保留期」的文件，被引用的永不删。实测：3824 字节的详情落盘、note 只剩 120 字 + 指针、按关键词检索到、按 hash 读回全文 |
| §6 没有设置页 | 设置页落地（只读）：列出全部 10 个可调项、默认值与改法（`cordis.patch.yml` 的 config 段）；默认值收敛到 `host/config-defaults.js` 一张表，页面与 host 共用，`test/settings.test.js` 校验两边不漂移。只读是有意的：配置文件是唯一真相，界面不该造出第二份。实测设置面板出现「MiOpIIk」入口并正常渲染 |
| §9 词表只兑现 3/5 | 「草稿」「今天的信」两个面做出来：抽屉新增两个 tab；「今天的信」直接读交接简报（含隔夜更新），空态明确说「今天还没有写信」 |
| §5.1 折叠的替换（已打通） | 走 preset 注册表取 compression 服务；回合中间切会切断步骤，所以排到 `turn/end` 执行；完成后 `markFoldReplaced` 补记 `appliedSeq`。实测：A-9 报「边界不合法」→ 改为延后 → A-11 返回 `scheduled-after-turn` |
| §5.1 折叠的「替换」一半做不到 | 两阶段的前半已落地：`ink_fold propose` 出影子提案（机械档案 + 开环结算），`review` 给验收理由，`approve` 必须过「每条活跃开环都有落点」的检查，且 Mind 可自带改写档案；`reject` 留理由。**但「原子替换」在插件里拿不到**：DSH 把 `compaction` 隔离在 agent preset 的 scope 内（`- id: compaction … isolate: { compaction: true }`），插件根上下文与 `agent.ctx` 都取不到（实测 `no-compaction-service`），`/compact` 命令通过 `commands.execute` 也返回空（`command:{"resultKind":null,…}`）。因此当前语义是「验收通过 → 记账为已折叠」，真正替换上下文要由用户或 Mind 走 `/compact`。要闭环需在 agent preset 内加一个配套 row——属于 profile 组合层改动，需单独决定 |
| §5.2 无自动收工检测 | 回合结束时只认明显道别（先这样/明天再说/晚安/bye…）记一条 `closing-signal`；L3 只在当天还没写简报时提醒一次（「这次对话像是在收工」），**不代写简报**；写了即消失 |
| §1.3 鱼骨树不存在 | 分支模型落地：`branches.jsonl` + `ink_branch`（open/summary/merge/abandon）+ `ink_dispatch` 的 `branch` 绑定；L3 列出活跃分支与任务计数；汇回主干产出带分支指针的预览；抽屉新增「鱼骨分支」一节 |
| §2.4/§3.2 判例与自答（实测） | J-3 无引用 → `hold` + T0 blocking 预览（不猜）；J-4 事实命中 → `answer` + 判例 C-1（引 F-2）；J-5 同类改写 → 引判例 C-1 且不新增判例。三条路径均实跑验证 |
| 判例匹配的边界 | 匹配是确定性的词面匹配（二元组/覆盖率取最大），同义改写可能落到「上报」；这是有意的保守方向（宁可上报，不猜），不视为缺陷 |

**截至本次，登记表已清空**：SPEC 里每一条写明「未做」的机制都已落地或在 11.2b 里被重新归类为代价。
若后续发现新的缺口，加回这里，不要只留在对话里。

### 11.2c 外部验证修复（2026-11-04，另一会话全量点测 12 个工具）

| 报告的问题 | 判定 | 处理 |
|---|---|---|
| `ink_recall` 怎么查都是空 | 真：只检索详情仓，而详情仓只在长文本时写 | 改成**统一检索**：详情 / note / 观测原文 / 分支 / 事实，一个入口；实测当场查出 13 条 |
| `ink_loops get` 调不通 | 真：schema 没有、实现也没有 | 补 `get`：返回开环 + 相关 note；实测可用 |
| `ink_branch get` 偶发 `value is not lossless JSON` | 真：运行中的任务对象可能带不可序列化字段 | 工具层统一 `lossless()` 净化；实测不再复现 |
| `ink_fold approve` 返回自相矛盾 | 真：`applied` 同时表示「验收」与「替换」 | 拆成 `settled`（提案状态）/ `contextReplaced`（上下文是否真被替换）/ `reason` |
| `ink_branch open` 的 quotes 没落库 | 真：open 只写 premise，quotes 要另调 context | open 直接接收并落库 premise/quotes/facts；实测 `get` 能读回 |


### 11.4 迁移事故与处理（2026-11-04）

| 现象 | 原因 | 处理 |
|---|---|---|
| 修好「账本按会话隔离」后，某些会话的鱼骨消失 | 旧布局（根目录混合账本）的自动迁移把**整批混写记录塞给了升级后第一个打开的会话**，于是 A 会话的分支被搬进 B 会话的目录 | 取消自动认领；新增 `tools/adopt-legacy.mjs`，按「记录时间戳落在哪个会话的活动区间」归还；已修复 `/home/data/models`（38 条记录回到「确定性推理与外置知识」，其中 `B-3 知识-推理解耦 / Spark 4B`），备份在 `.dsh/miopiik.bak` |
| 误以为那两个会话「完全没用过 Ink」 | 用工具名在日志里计数，数到的是**请求头里的 schema**，不是调用 | 真正的调用事件在 `tool-call` 块里：该会话 `ink_branch`×6、`ink_facts`×6、`ink_loops`×2 —— 用了，是数据被搬错了家 |

### 11.2b 已知边界（不是缺口，是代价；不打算靠加机制消除）

| 边界 | 为什么保留 |
|---|---|
| 折叠的「原子替换」 | **已打通，但替换本身仍会失败并已可自证**：监听 `session/event` 的 `turn/end`（`turn/end` 不是 Cordis 事件）；`apply-late` 记录带 `reason`，失败会往「流水」投一条 `fold` 记录，不再静默：压缩服务通过 `agentPresets.serviceFor(agent, 'compaction')` 解析（这是唯一能按 agent 拿到被 isolate 服务的位置）；替换**排到回合结束**执行——回合中间 `compactRegion` 会报边界不合法（会切断 step）。审核结果仍是「先记账、后替换」，替换完成后补记 `appliedSeq` |
| 判例与纠错都是词面匹配 | 同义改写可能落进「上报」而不是「自答」。这是有意的保守方向：宁可上报，也不猜 |
| 「结构上硬、判断上软」里的软的那一半 | 展示时机、开场只说一件事、不播报进度——这些写进章程但没有技术强制。能强制的会变成规则，会变成新的仪式 |
| 用户词表之外不出现内部术语 | 靠文案纪律，不靠类型系统；`test/settings.test.js` 这类漂移测试只能守住可枚举的部分 |

### 11.3 已验证生效（对照实现）

- 观测日志：只收 `source.kind=user` 的真人消息与助手最终消息（goal/time-context/tool 等系统注入已过滤）。
- 开环：登记/触碰/闭合/丢弃、2 天休眠/7 天折叠、活跃上限 12 的固定折叠顺序、休眠投递预览（结尾为开环改写的疑问句）。
- 收件箱：T0–T3 分层、epoch 过期降一级、同一开环一条待读（后来的 supersede 旧的）、每轮 3 条 + 计数。
- 事实卡：provenance / conf / source 权威序（user > ink > operator）/ 失效不删。
- L3：活跃开环 + 收件箱摘要经 `systemPrompt.context` 每轮装配（空则不出现）；交接简报在隔夜后置顶。
- 窄工具面：`ink_status` / `ink_loops` / `ink_facts` / `ink_inbox` / `ink_dispatch` / `ink_commit` / `ink_brief`；子 agent 被 `tools.restrict` 挡掉。
- 派发：六要素契约校验（缺则拒绝并给出缺失清单）→ `ctx.subagents` 以 `delivery: caller` 启动 → 结果回 Ink → `ctx.llm` 编译为预览 → 进收件箱；守夜超时投递 `[阻塞]`。
- 客户端：存在感胶囊在**会话顶栏**（会话级、非导航）；抽屉在组件内渲染为覆盖层、两个面板入口与页面（数据待接）。
- 收件箱三区与展开：`ink_inbox open` 取回 note detail；`zone=unread/history/starred` 均有实测。
- epoch：`ink_epoch advance` 持久化；旧预览按 epoch 降一级（不删）。
- 事实卡写入：`ink_facts add` 实测（F-1 记录本次审计结论）。
- 客户端：存在感为诚实的「后台」入口；两个面在抽屉内以 tab 切换；全局面板不再出现 MiOpIIk 入口（不做导航栏）。
- 派发端到端：J-1 由 Operator 完成 → `ctx.llm` 编译 → I-1 预览（T1，带问题）→ L3 展示 → 审计报告采纳（docs/audit-2026-11-04.md）。
- 鱼骨图：`graph` 载荷（主干轮次 / 分支分叉点 / 任务 / 汇回点）+ SVG 渲染实测（截图为真实会话的 5 条分支）
- 客户端数据面：session projection `miopiikBackstage` 实测（抽屉列出 L-1/L-3、F-1、在跑任务；存在感在有任务时带数字）。
- 干预通道：按钮 → session command `/miopiik` → host 同一操作；实测 L-3 从界面划掉（`by:"user"`），会话日志留 `command/run`/`command/done`。
- 草稿区实测：`ink_draft add` → P-1 出现在抽屉「后台在跑」；7 天老化、闸门批准/拒绝 settle 均有单测。
- 交接简报：单屏上限（>1800 字拒绝）、隔夜更新追加并在 L3 逐条显示、硬断提示，均有单测。
- 审计视图实测：抽屉底部「取证」展开决定账（D-1 preview）。
- Operator 问答通道：`ink_ask` 实跑三条路径——无引用上报（J-3）、事实引用并生成判例（J-4 → C-1）、同类改写引判例复用（J-5）；`ink_ask` 对 Mind 不可见（仅 Operator）。
- 实跑发现并修复：`ink_ask` 首次上线时 `childId is not defined`，Operator 如实报告通道故障、未编造引用；修复后重跑通过。
- 纠错前置：编译输入含 Mind 最近 8 句（首行）；矛盾时标 `contradicts`/原句，note 变「更正候选」（单测覆盖解析与字段）。
- 硬断事后折叠：`detectGap` + `foldDay` + L3 断点横幅均有单测（跨天无简报 → 盘外素材）。
- 鱼骨分支：`ink_branch` 四动作 + 汇回主干 + L3 列表 + 抽屉展示，单测覆盖（分叉点/任务计数/merge/abandon/摘要更新）。
- 纠错：`utteranceIndex`（稳定 U-id）+ `relevantUtterances`（最近 + 相关旧话）+ 编译指认；单测覆盖「很久以前那句被捞出来」与「id 跨回放稳定」。
- 收工：`closing-signal` 与 L3 提醒；单测覆盖道别命中与普通聊天不误报。
- 跨天验收：用真实「昨天的账本 + 重启」验证 §10.1–10.4（4 条全过），不是时钟模拟。
- 草稿态派发：实测 J-7（只有一句目标）→ 产出进 P-2 草稿区、收件箱零新增、开环自动 settle。
- 单测：78 项通过（纯逻辑 + 引擎回放 + 契约 + 编译解析 + 收件箱三区/展开 + 无损观测 + L3 顺序 + 干预命令解析 + 草稿/简报/老化 + 判例匹配 + 问答三态 + 纠错/断点）。

---

## 12. Extra 展示层（不计入不变式）

> 定位：附加层。删掉它，MiOpIIk 照样成立；它不写两份日志、不改闸门、不占 L3 预算、不改开环/事实的数据形状。

- **两个表面**（对齐《Harness WebUI 技术参考手册》§16 的 Dual-Surface）：**对话表面** = 正文里的一两张卡（能内嵌、跟着主题）；**工作区表面** = 「视图」页的只读快照。对话仍是主体，不把对话变成仪表盘。
- **可信目录**：模型只能挑已注册的形状与预设样式（Level A 原生组合 / Level B 受限 JSON 形状）；不做 Level C 的任意 SVG 事件，也不做 Level D 的第三方应用容器。
- **动作分级**：`choice` 的动作带 `kind`（local / read / write / sensitive），对应手册 §8 的 L0–L3；v1 只渲染、不执行，卡片不冒充已经发生的操作。

- **一个 IR，五个投影**：`dataset`（表格/条形，columns+rows）、`graph`（节点+边，按 lane 分列）、`timeline`（时间序列）、`text`（段落/列表）、`choice`（≤2 个动作）、`media`（图片/链接），外加 `layout` 容器（stack/row/grid，嵌套 ≤2 层）。
- **spec 是数据，不是像素**：落盘的是 `{widget, title?, props, fallback}`；渲染器负责长相，样式只用设计 token，spec 内不允许出现 CSS。
- **协议 v2**：`{ v, widget, preset, title, props, fallback }`。`preset` 只能从 `card / plain / inset / stat` 里挑——模型只挑名字，不写样式；多余字段在校验时丢弃；`layout` 最深两层。
- **硬规则**：`fallback` 必填（≤300 字；导出与降级的唯一出口），且**只在渲染失败时**顶上，不常驻卡底；未知 widget / preset 报错并列出可用清单，不静默降级；一张卡只放一个决定；只读——一切交互都回到对话或 session command。
- **预算**：`title` ≤80 字、`dataset` ≤200 行、`graph` ≤60 节点/120 边、`timeline` ≤24 项、`layout` ≤6 子项且最深两层、单元格 ≤4000 字；超预算就拒收，不截断后假装渲染成功。
- **数据要有出处**：`props.source` / `props.note` 画进卡底（画像写进 SVG 的 `<title>`/`<desc>`），避免演示数据冒充实时。
- **安全边界**：模型输出按不可信数据处理——只认白名单字段（多余键在 Host 侧丢弃）、不执行任意 JS/HTML/CSS、媒体只接受 http(s) 或工作区绝对路径。
- **无障碍**：卡片带 `role=group` 与 `aria-label`（标题或 fallback），SVG 图带 `role=img` + `<title>`/`<desc>`，降级文案就是文字摘要。
- **图片**：`media` 支持 `url`（http(s)）与 `path`（绝对路径，走带会话鉴权的 `api/file` 路由），与正文 markdown 里的本地图同一套地址。
- **开关**：正文内嵌不是配置项，是注册/注销——设置页一开关，关掉时 `dispose` 掉 `assistant-step` 的接管，原生渲染立刻回来。
- **入口**：`ink_view` 工具（show / list / clear）。**卡片长在对话正文里**：注册一个 `target: 'chat'` 的 Conversation Definition，认 `ink_view` 的 `tool/call` 事件，在 **Turn 层**（`groupTree: 'turn'`）产出一个节点，由 `conversation.chat.node` 槽位渲染——卡片站在调用处，不进可折叠的「过程」组；同时进 MiOpIIk 页的「视图」页签；快照只带最近 3 条。
- **不做的**：不做自由 HTML；不做第二套设计系统；不做模型生成组件代码；不接管别人的 `tool.call.toolview` / `conversation.chat.commandview`（那两个席位属于 DSH 与其他插件的工具；只有 MiOpIIk 自己的 14 个 `ink_*` 工具行与 `miopiik` 命令行例外，见 §13.11——卡仍然跟着过程组折叠，不抢对话版面）。

---

## 13. 11-06 后落地机制补记（2026-11-21）

> 本节补记 2026-11-06（第三轮对齐）之后落地的机制，收敛 [docs/ALIGNMENT-AUDIT.md](docs/ALIGNMENT-AUDIT.md) §16.2 点名的「SPEC 失同步」。术语与实现逐字一致（`auditPage` / `assembleL3` / `VOLATILE_KEYS` / `suggestedClose` 等），每条附盘上佐证（文件:行 或 测试名）；第四轮逐字核对的取证与裁决记录见该文档 §16，本节只收录已落地部分，未收口的缺口如实归入 §13.8「已知限制」。`host/engine.js` 与 `host/converse.js` 当晚仍在收口未提交改动（低置信闸门），这两处引标识符不引行号；其余文件的行号以 2026-11-21 盘上状态为准。

### 13.1 对话编译与静默吸收（修订 §3.1 出口）

- **触发**：`turn/end` 后 Ink 先把该轮用户原话与 Mind 最终回复 append 进自己的上下文，随即跑一次对话编译（`engine.finishTurn` → `scheduleConversationPass`，`host/engine.js`）；同一时刻只跑一遍（busy 位），失败静默——候选是增量，不打扰回合。
- **开关**：`conversationCompile`（默认开），经 `readConfig` 解包 volatile 引用，设置页改完免重启（`scheduleConversationPass` 首行检查）。
- **产出形状**：`{ claims, loops, closedLoops, question }`，claims 与 loops 各上限 3（`CONVERSATION_SYSTEM`）。开环只用六型 `LOOP_TYPES`，与 §4.3 一一对应（unanswered-question / awaiting-user / pending-option / promise / pending-dispatch / forming-intent）。**没有出处（U-n）不产**：解析时逐条丢弃无引用候选（`parseConversationOutput`）；closedLoops 只认活跃开环 id；解析失败重试一次（要求纯 JSON），再失败返回 null——不投降级预览。conf 可选：缺省或不认识的值视为未标注，只有模型明说 `"low"` 才触发低置信闸门。模型沿用 `inkModel`，空=继承会话（`host/compile.js:81-93`）；60 秒超时、低推理档。
- **出口分两路**（`engine.applyConversationCompile`）：
  - **静默吸收**（未标注与 mid/high 的 claims，及全部 loops / closedLoops）：结论落事实卡——`source: ink`、`scope: session`，带 `supersedes F-n` 时旧卡先失效，与既有结论相似度 ≥0.6 去重；开环落账同去重；疑似已解的只挂 `loop.suggestedClose = true`，**闭合权仍在 Mind**。记一条 `kind: absorb`、`why: compile:conversation` 的 note（claim 是「这段里像是有 N 条结论、M 条悬着的话」，候选清单进 detail），不占收件箱待读位；本批无可静默结算时不补空 absorb。
  - **低置信闸门**（模型自标 `conf:"low"` 的 claims，2026-11-21 落地）：不静默落账，逐条投收件箱——`kind: 'preview'`、`why: 'compile:low-confidence'`、「后台整理出一条没把握的结论：…」→「要不要立为已定结论？」——拿不准的结论经用户过目再立。直接回应 ALIGNMENT-AUDIT §16.2 #2 对「静默写事实」的预警。
- **L3 提示**：挂了 `suggestedClose` 的开环在 L3 行尾带「（Ink 提示：看似已解）」（`assembleL3` 的「悬着的事」段），见 §13.2。
- 佐证：`test/converse.test.js` 9 项（出处过滤 / 未知类型丢弃 / 空产出 null / closedLoops 按活跃清单过滤 / conf 缺省视为未标注等）；`test/engine.test.js`——「对话编译静默落账：applyConversationCompile 直接写事实与开环、标记疑似已解、记 absorb 笔记且不占收件箱」「低置信闸门：conf=low 的结论不落事实卡，逐条投收件箱、留痕可查，read 可消化」「低置信闸门只作用于 claims：同批 loops 照旧登记、closedLoops 照旧标疑似已解，absorb 留痕有把握的部分」「回归钉住：未标注 conf 的对话结论照旧静默落账，低置信闸门不误伤」「混合批次：低置信投收件箱、未标注的照旧落账，absorb 只结算有把握的部分」。

### 13.2 装配式 L3（`assembleL3`）

- L3 由 `engine.assembleL3()` 一次装配：`text`（注入原文）与 `sections`（分节现值）**出自同一次装配**，快照的 `l3` 块与 `prompt.js` 注入的 `miopiik:l3` 因此永远同文——防漂移靠结构，不靠约定（`assembleL3` 注释、快照 `l3` 块；注入走 `engine.l3Text()` 即 `assembleL3().text`，`host/prompt.js:39`）。
- 注入形态是 `systemPrompt.context`（装配时求值、空则空串），不是会进聊天记录的 user 消息（`host/prompt.js:7-8/30-44`，`miopiik:l3` order 810）；`text` 行数上限 20（`MAX_L3_LINES`）。
- `sections` 形状（供客户端「所见」页渲染现值）：`facts`（id/claim/conf/source/scope）、`loops`（id/text/type/closureCondition/suggestedClose）、`inbox`（id/tier/claim/question）。
- 佐证：`test/engine.test.js`「l3：sections 与 text 同一次装配，快照与注入 Mind 的原文同文」「l3：事实超过 8 条走计数行，计数 === sections 全长」。

### 13.3 全量流水（audit 取数通道）

> 与 `snapshot.audit` 的尾部采样（notes 最近 40 条）不同：这里直接读会话目录的 JSONL 原始日志（append-only，回放即真相），把每一条可重建操作的记录映射成统一行形状，按 `(at, seq)` 新者在前排序，从最新可以**无缺口翻到最早**（`host/audit.js:1-9` 顶部注释；`engine.auditPage` 的注释同一口径）。纯函数模块：不碰 Engine 状态、不写文件；每次现读磁盘、不做缓存——错缓存比慢更糟（`host/audit.js:311-315`）。

- **行形状**：`{ id, at, day, kind, actor, claim, refs, branch?, detail? }`（`host/audit.js:62`）。id 是账本对象的 id，同一对象多条操作行靠 kind/at 区分；actor 只写记录里真正可判定的字段，判不出的用引擎默认，不凭空造（`host/audit.js:63-64`）。
- **kind 覆盖**：note 子类（absorb/answer/hold/preview…）直接作 kind；`loop.add/touch/status/close/drop`；`fact.add/revise/invalidate`；`inbox.deliver/read/star/unstar/defer/supersede`；`job.dispatch/update`；`draft.add/settle`；`branch.fork/summary/context/attach-job/merge/abandon`；`briefing`（及 `briefing.overnight/auto-materials/closing-signal/hard-break`）；`fold.propose/apply/reject/apply-late`；观测只收 `epoch` 与 `fold.compaction`，对话原文归主界面不重复进流水（`host/audit.js:81-308/92-97`）。
- **参与日志**：`AUDIT_LOGS` 十本——notes / loops / facts / inbox / briefings / jobs / drafts / branches / folds / observations（`host/audit.js:16`）；工作区共享事实的操作行也收，detail 标 `scope: workspace`（`host/audit.js:333-347`）。
- **分页**：`auditPage(rows, input)`（`host/audit.js:370`）。day 模式只出该天行：当天翻不完给同日游标 `{ day, before, beforeSeq }`，翻完给「下一个有数据的日子」；游标模式 `nextCursor = { before, beforeSeq, day }`，`(at, seq)` 字典序排除同毫秒并列时的漏行/重行——无缺口从最新翻到最早（`host/audit.js:363-369`）。
- **命令通道**：`/miopiik audit [page] day=… limit=… kind=… branch=…`（游标键 before/beforeSeq；用法示例 `audit day=20778 limit=50`，`host/commands.js:26`）。结果 JSON `{ rows, nextCursor }` 装进 command result text 带回浏览器；`recordInput: false`，每次 execute 落 `command/run` + `command/done` 两条 log-only 事件——返回文本留痕是代价，limit 由 `AUDIT_PAGE_MAX = 200` 封顶、默认 50（`host/commands.js:12-13/77/84-87`、`host/audit.js:19-20`）。
- 佐证：`test/audit.test.js` 10 项（统一行形状覆盖全部可重建操作 / before 游标全量无缺口走一遍 / 按天分页同日续翻 / kind 与 branch 过滤 / 磁盘文件就是真相）；`test/commands.test.js`「取数通道往返：/miopiik audit 命令注册 → execute → JSON 解析 → 游标续翻」。

### 13.4 鱼骨 graph.links 与主干截断标记

- 快照 `graph` 载荷新增**线间关系**：两条分支依赖同一张事实卡 = 鱼骨的肋骨之间有真实的交接。只有结构事实，不做语义推断：`links.push({ kind: 'shared-fact', factId, between: [B-i, B-j] })`。2026-11-22 起推导口径由「只看 `context.facts` 交集」扩为**三源并集**（见 §13.9），行形状不变。
- 主干左脊只取最近 16 轮，同时给出 `turnsTotal`（全部轮数）与 `turnsTruncated`（是否截断）——客户端能知道「还有多少没显示」。任务节点带 `stopReason`；`counts` 汇总 activeLoops / facts / running / drafts。
- 佐证：`test/engine.test.js`「graph：links 按分支事实交集计算，任务带 stopReason，主干有总数与截断标记」「graph：主干超过 16 轮时 turnsTotal/turnsTruncated 说真话」。

### 13.5 双协议零依赖 Config 与热生效控件

- `host/config-defaults.js` 是可调项的唯一出口，三件事（顶部注释 `:1-16`）：`DEFAULTS`（全部内置默认值）；`Config`（手写**零依赖** schema，同时满足两套协议）；`readConfig(config, key)`（host 侧统一读法：volatile 引用解包成当前值，「禁止启动时一次性快照」，`:60-67`）。
  - **Cordis Standard Schema**：`~standard.validate(config)` 把 4 个 volatile 字段包成 cosmokit volatile 引用（`get()` + `Symbol.for('cosmokit.volatile.write')`）——DSH 改 cordis.patch.yml 后由 loader 原位写入引用，**插件免重启热生效**（`:19/69-78/163-165`）。
  - **DSH Settings wire**：`uid/type/meta/dict/toJSON()` 结构与 schemastery 的 wire 格式逐位兼容，`new Schemastery(Config.toJSON())` 可无损还原（`:95-127`）。
  - 不引入任何 npm 依赖；协议行为按 DSH 自带 cosmokit/schemastery 的实测语义手写（`:14-15`）。
- **热生效四项 `VOLATILE_KEYS`**：`conversationCompile` / `operatorModel` / `activeLoopCap` / `operatorTimeoutMs`（`host/config-defaults.js:40-45`）。host 读点全部走 `readConfig`：活跃开环上限 `engine.loopCap()`、对话编译开关（`scheduleConversationPass` 首行）、Operator 模型与超时（`host/operator.js:48/276`）。
- 客户端 4 个控件与 `VOLATILE_KEYS` 一一对应（checkbox/text/number/number，`client.js:1408-1416`），测试守卫不漂移。
- 佐证：`test/settings.test.js`——「4 个 volatile 字段与 host 默认值一一对应，不漂移」「Cordis Standard Schema：validate 把 4 个字段包成 volatile 引用（含写入符号与 get）」「volatile 引用可原位写入（DSH loader 热更新路径），readConfig 动态解包」「Config 的 DSH Settings 结构：uid/type/meta/dict/toJSON()」「new Schemastery(Config.toJSON()) 可无损还原 4 个 volatile 字段」「校验失败按 standard-schema 回报 issues（Host 写入被拒而非静默）」「客户端 4 个控件与 host 的 VOLATILE_KEYS 不漂移，控件类型对应」。

### 13.6 章程合并后的九条（`host/prompt.js`）

Mind 的章程合并为九条（`CHARTER`，`host/prompt.js:11-20`；`systemPrompt.section` 注册名 `miopiik:charter`，order 650）。只写结构约定，不写礼貌建议——工具面本身已经限制了能力（`host/prompt.js:4`）：

1. 用户只跟 Mind 说话；Ink 与 Operator 不面向用户。
2. 工具纪律：**纯讨论零记账**（Ink 在每回合结束静默提炼落账）；L3 所见即全部，回复前不做例行巡检；动手只在拍板或纠偏——派发、对外提交、翻阅未内联详情、修正/闭合 Ink 自动记录的条目。
3. 开环只由 Mind 闭合（`ink_loops close/drop`）；Ink 只在 L3 提示「（Ink 提示：看似已解）」。
4. 派发前自检：一句话复述目标 + 说得出「完成是什么样子」；派发走 `ink_branch` 挂切片，Operator 不拿整个对话。
5. 草稿态 Mind 自行决定；对外 commit 必须用户点头，只需回答「行/不行」；提交门文字只写用户要判断的那件事，不写自我描述。
6. 自答必须带引用（事实卡/判例）；带不出引用就上报，不替用户发明结论。
7. 展示是提议不是倾倒，只在话题间隙；后台细节不进对话，不播报批次号/测试数/提交哈希。
8. 隔天开工先读 L3 简报与收件箱，开场最多提一件事；没有告别就断了，先承认断点。
9. 事实卡不是记事板：只记「以后会改变判断」的结论，默认本会话生效；跨会话才用 workspace；原料与半成品丢 `ink_draft`。

### 13.7 插件页单页形态（`plugins.bundle.config`）

- 配置面收进官方插件管理页声明的**唯一**配置 slot `plugins.bundle.config`（key `miopiik-dsh`，`client.js:1402-1406/1884-1886`）：**上半一句话介绍**（`MIO_INTRO`，`client.js:1417-1419`），**下半 4 个真实生效控件**（`MIO_FIELDS` 即 §13.5 四项）。控件数据来自 DSH settings 服务 `configForms.get('miopiik-dsh')`，保存走 `mutate` → Host 落盘 profile patch 层 → volatile 引用原位更新，免重启生效（`client.js:1404-1405`）。
- 无 settings 服务或命名空间不可用时**不伪造控件**，给静态提示（`client.js:1626`）；Host 拒写或只读部署下控件禁用。页面只用 DSH 设计 token，无品牌 Hero/渐变/大圆角卡片。
- 「设置 → 内置插件」占坑配置页已撤除（ALIGNMENT-AUDIT §16.1 第一行的处置）。**本节取代 §11.2「设置页落地（只读）」行的状态**：只读列表面已不是现状，真控件经 `mutate` 可写、热生效。
- 佐证：`test/miopiik-settings-ui.test.js`——「MiOpIIk Agent 只注册插件页一个配置面，settings.plugins.tab 占坑已撤」「插件页上半部分只有一句话介绍，不再有架构长文与组件表」「插件页下半部分是 4 个真实控件：经 configForms 读当前值，保存走 mutate」「无 settings 服务或命名空间不可用时不伪造控件」「Host 拒写或只读部署下控件禁用，不出现假开关」「插件页不使用品牌 Hero、渐变或大型圆角卡片，且只用主题 token」。

### 13.8 第四轮对齐核对与已知限制

第四轮逐字核对（对照最早对话全量重排）见 [docs/ALIGNMENT-AUDIT.md](docs/ALIGNMENT-AUDIT.md) §16：完全偏离项为 0（§16.1）。本节只收录其缺口清单中仍未收口的部分，**如实记为已知限制，不是已实现**：

| 已知限制 | 现状与佐证 |
|---|---|
| `loop.suggestedClose` 不落日志 | `applyConversationCompile` 的 closedLoops 分支只改内存 loop，`loops.jsonl` 没有对应 op 记录（只有赋值、无 `appendRecord`）——重启回放后「看似已解」提示消失。闭合权本就在 Mind，不会产生错误闭合；是否补一条 op 待裁决 |
| 非 Lead 会话任务板静默跳过 | DSH 共享任务板需要 Lead 会话（会籍）；普通会话开卡被静默跳过，Operator 可见性只有「子会话」与「流水 job 行」（ALIGNMENT-AUDIT §11 已知限制、§16.5 #4，至今未获裁决） |
| 章程纯提示词约束余量 | 工具面硬限制已成主力，但九条里仍有无技术强制的软约束（ALIGNMENT-AUDIT §16.2 #1，回正中） |
| Ink 静默写事实的准确性 | 最险的一段已上闸：模型自标 `conf:"low"` 的结论不静默、投收件箱过目（§13.1 低置信闸门，直接回应 §16.2 #2 的预警）。余量仍在：自标有把握的（mid/high/未标注）不经用户过目就进 L3——absorb 落账留痕、可 revise/invalidate、`source=user` 权威更高仍是主兜底，这一环继续盯 |
| 最早愿景仍未落地 | 分支递归（分支下再开子分支）、Mind 的上下文长度自觉（ALIGNMENT-AUDIT §16.5 #1/#3，不是偏离，是没做）；跨分支可见性的 host 数据层（`graph.links`）已由 §13.4 落地，客户端呈现与验收状态按该文档约定「待验收后另记」 |

补记时实测（2026-11-21）：全量 `node --test` 180 项全绿，含当晚收口的低置信闸门新测试（engine 4 项 + converse 2 项）。

### 13.9 线间往来层三件修法（2026-11-22）

> 鱼骨「线间往来层」的三项结构性修法：往来连线改账本实据推导、头部补图例与空态、SVG 随分支细节面板缩宽。边界：`links` 行形状不变（`{ kind: 'shared-fact', factId, between: [a, b] }`），前端消费端不改即可继续渲染；`ink_commit` 提交门、`/miopiik audit` 通道、`assembleL3` 契约、三 pane 其余功能全部未动。

- **links 三源推导口径**（`host/engine.js` graph 装配处）：每条分支先算自己的依赖集合，再取两两交集成 `shared-fact` link；只做结构 id 匹配，禁止任何文本语义推断。依赖集合是三源并集：
  - a. `branch.context.facts` —— 开分支 / `ink_branch context` 的手动声明（仍然有效）；
  - b. 该分支名下 job 记录的 `facts` 字段（`job.facts`，`ink_dispatch` 派发时随合约声明，随 `jobs.jsonl` 落账、跨回放存活）；
  - c. 挂在该分支（`note.branch`）的笔记 `refs` 里出现且账本里真实存在的 `F-*` id（悬空指针不算依赖）。
- **`ink_dispatch.facts` 语义**（`host/tools.js` + `host/operator.js`）：可选参数 `facts: string[]`（合约依赖的事实卡 id）。未知 id 直接报错——与 `updateBranchContext` 同口径（`引用了不存在的事实卡：…`），且校验先于开分支等一切落账动作，不留半开分支或脏 job；合法则随 job 记录写入 jobs 账本（`job.facts`）。它只进账本不进 Operator 提示词——Operator 要知道结论内容时，要么看分支切片（`branch.context.facts` 的渲染），要么 `ink_ask`；Mind 想让 Operator 看见某事实，写进契约正文即可。**不传时行为与现状逐字节一致**：job 记录不出现 `facts` 键（JSONL 只增字段，不改旧字段语义）。
- **图例与空态语义**（`client.js` 鱼骨 pane）：
  - 图例一行放在最近轮次标记（`graph.recentTurns/allTurns`）正下方的头部区：实线弧=接出、虚线弧=接回、横虚线+小方块=共享事实、方=Operator 任务、圆=Ink 事件；图形与文字全部沿用 `C.*` 主题变量，文案键 `graph.legendFork/legendMerge/legendSharedFact/legendJob/legendEvent`（中英双语）。2026-11-04 撤掉的旧图例是 `graph.legend` 单键长文段落，这次按契约裁决回归的是**一行紧凑形状图例**，`test/settings.test.js` 的守卫相应改拦旧形态（`'graph.legend':` 单键段落）。
  - 空态：`links` 为空**且**无任何 merge/abandon 事件时，泳道区显示一行淡字「两线之间暂无往来」（`graph.noLinks`，中英双语，`data-miopiik-no-links`）；有任何往来或归档内容就不显示——如实说空，不硬凑。
- **SVG 缩宽方案**：选中分支（aside 细节面板展开，占 340px 列宽）时，鱼骨 SVG 整体缩宽适配可用列宽——`viewBox` 不变，`width: '100%'`、高度走 `height:'auto' + aspectRatio: "W / H"` 随比例缩放，泳道区不再被面板覆盖；缩宽态悬停气泡坐标同步换算成百分比钉在画布上。未选中时保持现状定宽像素（`width: W, height: H`），收起即复原。
- 佐证：`test/engine.test.js`——「鱼骨 links 三源并集：context.facts、job.facts、分支笔记 refs 同权，交集才成线」「鱼骨 links：两分支无任何共同事实时为空数组，悬空 F-\* 引用不算依赖」；`test/dispatch-facts.test.js` 3 项（合法落账跨回放存活 / 未知 id 报错不落脏记录 / 不传时记录形状与现状逐字节一致）；`test/miopiik-views-ui.test.js`——「鱼骨：头部图例一行在场……」「鱼骨：无往来且无汇回/放弃时泳道区一行淡字……」「鱼骨：选中分支（细节面板展开）时整图缩宽适配列宽，viewBox 不变，收起复原」「鱼骨新增文案键在 zh/en 两本字典里都齐」。

补记时实测（2026-11-22）：全量 `node --test` 205 项全绿（2026-11-21 基线 196 + 本批 9：engine 2、dispatch 3、views 4；含一处既有守卫按契约裁决改拦旧图例形态）。

### 13.10 Mind 署名三处落地：鱼骨 Mind 泳道、流水行面小签、所见折叠段（2026-11-22）

> Mind 层一直在账本上署名干活，但三视图上看不见它：actor 只在点开的行详情里露脸，鱼骨把圆点统一写成「Ink 事件」，Mind 的手动决策与 Ink 的自动结算在视图上无法区分。本节把这层署名呈现出来——**推导只在 host，客户端只做布局与署名呈现**。边界全部未动：`ink_commit` 提交门、`/miopiik audit` 通道与 audit.js 行口径、`assembleL3` 的 `{text, sections}` 契约（所见新增段走客户端渲染，L3 注入文本逐字不变）、JSONL 只增字段（`graph.mindEvents` 是 graph 载荷新增键，旧键语义不动）、不碰 miopiik-iui 与 DSH 壳。

- **mind 事件推导口径**（`host/audit.js` 的 `collectMindRows(dir, sharedPath)`，`MIND_EVENTS_MAX = 40`）：与 `collectAuditRows` **同一本 JSONL 账本、同一读法**（每次现读磁盘、坏行跳过、不缓存），筛「actor 手笔可判定为 Mind」的动作行，行形状 `{ id, at, kind, label, refs }`——id 是账本对象 id（点击走流水溯源的既有通道），升序排后只留最近 40 条防载荷爆炸。判定纪律与 audit 同源：**只认记录里真正可判定的字段，判不出就不收、label 判不出就给 kind 原文，禁止凭空造**：
  - 全收：只经 Mind 窄工具面可产生的 op——`branch.fork/summary/context/merge/abandon`（ink_branch）、`job.dispatch`（ink_dispatch：派发决定是 Mind 的手笔）、`inbox.read/star/unstar/defer`（ink_inbox）、`fact.revise`（ink_facts）、`briefing` 与 `briefing.overnight`（ink_brief）。
  - 只认字段：`loop.close/drop` 只认 `by === 'mind'`（草稿收尾写 `by:'ink'`、界面干预写 `by:'user'`，都不冒领）；`fact.add` 只认 `source === 'user'`（`ink_report` 写 `operator`、编译回灌写 `ink`）；`draft.add` 只认 `source !== 'operator'`；`draft.settle` 只认 `status !== 'expired'`（七天过期是 Ink 的老化）；`fold.apply/reject` 只认 `by === 'mind'`。
  - 可判定剔除：`loop.add` 是 Mind 登记开环的手笔，但派发记账开环（`operator.js` 写的 `type: 'pending-dispatch' + pointer: J-*`）判定为 Operator 署名，不进流。
  - **已知限制（如实记）**：Ink 对话编译（§13.1）回灌的开环记录与 Mind 手写在账本形状上不可区分，随 `loop.add` 一并按 Mind 手笔收录——工具面语义是「开环由 Mind 登记」，编译只是代拟候选；同一批在流水的 `actor` 面上仍是 `ink`，两处口径差异如实呈现，不互相冒充。工作区共享事实账本（`shared/facts.jsonl`）按同一 fact 口径收录（`scope: workspace` 的 source=user 立卡是 Mind 手笔，与 audit 收共享行同源）。
  - label 例：`并回 B-1`、`派发 J-10`、`闭合 L-24`、`读收件箱 I-3`——动词 + 可判定账本 id；对象 id 缺失的记录退回 kind 原文（如 `loop.close`），`at` 不可判定的记录直接丢弃。
- **鱼骨 Mind 泳道**（`client.js` FishboneView）：单开一条常驻窄道（虚线细基线 + 标题 `graph.mindLane`）；2026-11-23 聚簇后（§13.13）移到**分支泳道右侧**，把脊右侧让给该轮的用户原话：`graph.mindEvents` 按时间落点画**菱形节点**（与圆/方都不同形，主色描边，`data-miopiik-mind-node`）——形状语言补全为「圆 = Ink 侧事件，方 = Operator 任务，菱形 = Mind 动作」。悬停气泡给 label + refs + 时间 + `graph.mindHint` 说明；点击走既有 `traceId` 通道按账本对象 id 过滤流水溯源（简报行无对象 id，溯源为空、留撤销片，如实呈现）。图例**补一行**（第一行已贴满头部宽）：第二行 `legend-mind` 菱形图形 + `graph.legendMind`「菱形=Mind 动作」，中英双语；`padTop` 58→74 为两行图例让位，任何事件节点（圆/方/菱形）的点击与悬停区不与图例重叠。
- **缩宽态头部遮挡修复**（实测病灶）：aside 展开整图缩宽后，顶部事件节点正好落进 DSH 会话壳盖在视图区上的**隐形 col-resize 宽柄**（`.wSkVaW_widthHandle`，`position:absolute`、`z-index:0`、纵贯整列，平时 opacity 0 不可见），点击与悬停全被它吃掉——实测中整条 B-1 泳道在缩宽态全部不可点。修法：MiOpIIk 视图根自提一层（`position: relative; zIndex: 1`，`client.js` MiOpIIkView 根 style）越过宽柄的 `z-index: 0`——**壳元素一个不改**，指针命中归视图内容；`wSkVaW_body` 是 position:relative + z-index:auto（不建层），两层同处一个层叠上下文，zIndex 1 必胜。该条对四个 pane 一体生效（宽柄纵贯整列，不止鱼骨）。
- **流水行面 actor 小签**（`client.js` ActorChip）：每行行尾一枚小签（`data-miopiik-actor`），不用点开行详情即可辨认手笔；文本走 i18n 键 `actor.mind/ink/operator/user`，悬停说明走 `actor.*Hint`（中英）。三色走 `C.*` 主题变量：mind=品牌蓝（与脊同源）、ink=中性灰（回合边界的静默结算）、operator=琥珀（与任务方点的运行色同源）。小签放在行尾：行内前三格（时间/kind/结论）次序不动；行详情里既有 `actor:` 行保留。
- **所见「Mind 最近动作」折叠段**（`client.js` ContextPane）：分节区新增一段，默认收起、交互与「Ink 装配明细」同款（`ctx.mind` 标题 + `ctx.mindExpand/mindCollapse` 开关 + `ctx.mindHint` 说明）；展开显示最近 8 条 mind 署名行的 kind+label+时间（`graph.mindEvents` 截窗尾、新者在前，`data-miopiik-mind-row`），每行 id 仍可点去流水溯源。**L3 原文块逐字不动**（`data-miopiik-l3-text` 与注入同文的既有测试继续钉住）。
- 佐证：`test/mindstream.test.js` 7 项——「真账本夹具下 Mind 手笔全收，行形状 {id, at, kind, label, refs}」（契约样例四种手笔逐个点名）「ink/operator/user 署名的行绝不进（合成夹具反向样例：派发记账开环、job.update、source 缺省/operator 的事实、by=ink/user 的闭合、operator 草稿、过期草稿、盘外素材、折叠提案）」「派发记账开环可判定剔除，Mind 手写 pending-dispatch 不误伤」「截窗生效——只留最近 40 条」「label 判不出就给 kind 原文，不凭空造」「快照 graph.mindEvents 与工作区共享事实口径」「投影键不漂移（graph 既有键全保留）」；`test/miopiik-views-ui.test.js` 新增 5 项——「鱼骨：Mind 泳道——脊右分支左、菱形节点、悬停 label+refs+时间、点击跳流水溯源」「鱼骨：图例补一行……两行图例都不压事件节点」「鱼骨：缩宽态头部不遮挡——视图自提一层越过壳宽柄条带」「流水：行面 actor 小签……三色走主题变量」「所见：Mind 最近动作折叠段默认收起，展开后最近 8 条」+「Mind 署名相关文案键在 zh/en 两本字典里都齐」（zh 逐字含 `菱形=Mind 动作` 与 `Mind 最近动作`）。

补记时实测（2026-11-22）：全量 `node --test` 218 项全绿（§13.9 基线 205 + 本批 13：mindstream 7、views 6；既有 205 项零破坏，含缩宽契约、流水分页、L3 同文与装配明细折叠的既有守卫）。

### 13.11 对话手笔的包装：ink_* 工具行与 miopiik 命令行（2026-11-22）

> 对话里 MiOpIIk 自己的两条痕迹一直是「机器口吻」：`ink_loops` 工具行露参数 JSON（`ink_loops · {"action":"close","id":"L-33"}`），`/miopiik audit` 命令行把整页流水 JSON 灌进对话（`miopiik · {"rows":[…]}`）。这两处都是我们自己的手笔，只有我们知道字段是什么意思，因此由我们接管两个 keyed 席位，把「账本词」翻成「人话 + 结构化正文」。这**修订** §12 那条「不接管 `tool.call.toolview`」的裁决：不接管别人的席位，接管自己的两处；只做展示层——不改 host 契约、不动工具返回给模型的文本、不加 `presentationMeta`、不发明数据。

- **两个席位**（`client.js` apply）：
  - `tool.call.toolview` × 14：`key` 逐个为 `ink_status / ink_loops / ink_facts / ink_inbox / ink_dispatch / ink_commit / ink_brief / ink_epoch / ink_draft / ink_ask / ink_report / ink_branch / ink_fold / ink_recall`（`INK_TOOL_NAMES`，注册在 `ctx.slots.inject` 里，席位缺席就退回 DSH 通用卡，不伪造内容）。
  - `conversation.chat.commandview` × 1：`key: 'miopiik'`（与 `host/commands.js` 注册的命令名逐字一致）。
- **折叠态是人话**（`inkToolLabel`）：名词（`ink.noun.*`）+ 动词（`ink.act.*`）+ 对象 id/主句，例如「开环 · 闭合 L-33」「事实卡 · 新增 用户裁定…」「鱼骨 · 并入 B-2 · 汇回」「提交门 · 行」。取字段一律走 `PartialArguments`（`inkArgsReader` 双面：流式视图与普通对象同一套接口），所以**参数还在流式增长时标题也成立**；结果落地后再补一句只有结果才知道的话（`inkToolOutcome`：状态、判定、条数——`ink_dispatch` 给 `jobId`、`ink_commit` 给行/不行、`ink_inbox` 给条数、`ink_status` 给三项指标）。状态词走本地化（`merged/open/abandoned` → `graph.merged/open/abandoned`），不把英文字段当人话。
- **展开态是结构化正文**（`inkBodyNodes`），点击走 DSH 的 `useDisclosure`——卡跟着过程组折叠，不另起交互体系：
  - 契约参数在前（`INK_ARG_FIELDS`：dispatch 的 goal/deliverables/acceptance/acceptanceSample/boundary/budget、commit 的 title/summary/draftId、ask 的 question、report 的 claim/evidence/conf、branch 的 label/summary/premise/quotes/claim/detail、recall 的查询条件……），字段名走 `ink.field.*` 人话。
  - 结果在后：单键包装（`{loop:{…}}`/`{fact:{…}}`/`{branch:{…}}`）先拆，对象按字段逐行，数组逐条给「id 小签 + 主句 + 状态/置信/来源/时间小签 + 次要字符串缩进一行」；整段 JSON 不再上屏。
  - `ink_status` 专门给一屏账（活跃/休眠/已闭/上限、事实与失效、待读、笔记与观测、T 轮/D 天/E 纪元）；`session` 号这类内部字段不上屏。
  - 失败态：标题转红、摘要写「没做成」、错误文本单独一行（不塞进正文冒充结果）；`preparing/start` 阶段摘要写「准备中…/进行中…」，`data-state` 分别为 `running`。
- **命令行只报做了什么**：`/miopiik audit` 的返回是整页 `{rows, nextCursor}` JSON，命令行只显示「账本翻页 · N 行」（`ink.cmd.audit/rows`），行数据在视图里、游标不上屏；`loop close/drop` 与 `fact invalidate` 的返回本来就是一句人话（`已划掉 L-33`），照抄；错误红点 + 错误文本。注意 `recordInput: false` 使 `node.args` 为空是常态——判定从 `node.outcome.text` 反推（JSON 分页 → 审计翻页，其余 → 人话），不依赖参数。
- **兜底与边界**：席位未注册/组件未挂上时，DSH 通用卡原样工作（不静默吞行）；只认自己那 15 个 key，别人的工具名不抢（`slotByKey(..., 'bash') === undefined` 有测试钉住）；不改 `output.render`（模型面文本逐字不变），不加 `presentationMeta`，不改 host/audit.js。
- **三视图同期小修**（同一批观感收口，不动数据契约）：
  - 鱼骨：图例与轮次窗口搬到画布外的 HTML 工具条（六项一行，窄列自动换行，不再被 viewBox 宽度切边）；泳道宽随可用列宽在 150–270 之间伸缩（`ResizeObserver` 测列宽，测不到时退回 150），宽屏把道摊开；泳道加淡底纹、Mind 道只留虚线基线；节点尺寸与字号上调（回合点 r=5、事件圆 r=6/7、任务方 12/14、菱形 8、行距 34）；画布是带边框圆角的表面（`C.layer1`），滚动区底部留 140px 让最后几行能滚到输入框之上。
  - 流水：kind 说人话（`stream.kind.*`：吸收/结论现状/鱼骨现状/待读预览/落结论/闭合开环/投递…），认不出的 kind 原样保留；kind 格窄化为 84px 并在 `title` 里留原始 kind；时间列 56px 等宽数字。
  - 所见：L3 原文默认收起（`展开原文` 旁给一句 `ctx.l3Hint`，点开仍逐字渲染、`data-miopiik-l3-text` 不变）；事实卡与悬案行把 `conf / source / scope / stale`、`type / 疑似已解` 做成小签（颜色走 `C.*`，source 色与 actor 小签同源）。
- 佐证：`test/miopiik-views-ui.test.js` 新增 8 项——「对话手笔：14 个 ink_* 工具行与 miopiik 命令行都接管了对应席位」「工具行：折叠态是人话……不再是参数 JSON」「工具行：展开是结构化正文——契约字段逐行、结果摊开，不回灌 JSON」「工具行：ink_status 展开是一屏账……不摊 session 号」「工具行：进行中与失败态各说各话……」「命令行：审计翻页只报「翻了多少」……」「命令行：干预动作照抄那句人话，出错才红着说」「对话手笔文案键在 zh/en 两本字典里都齐」；既有鱼骨图例/缩宽两项测试按新结构改写（图例改断言 HTML 工具条 + 图表 SVG 带 `data-miopiik-graph`），所见两项按默认收起补一次展开。

补记时实测（2026-11-22）：全量 `node --test` 226 项全绿（§13.10 基线 218 + 本批 8；含两处既有守卫按新结构改写，其余零破坏）。真浏览器复核（1280/1440 两档、深浅两模式）：「后台总览」工具行展开是五行指标账；`开环 · 闭合 L-31`/`收件箱 · 读了 I-15`/`鱼骨 · 并入 B-2 · 汇回` 等行不再露 JSON；命令行 `账本翻页 · 50 行` 取代整页 JSON；鱼骨图例六项可读、泳道摊开、深浅对比正常。

### 13.12 工具行配色对齐 DSH 与鱼骨可见性修复（2026-11-22）

> 用户点两件事：一是鱼骨「看起来消失了」，二是 DSH 官方工具行颜色很低调，希望统一。两条都收在展示层（`client.js`），不动 host 契约与账本。

- **工具行/命令行配色对齐 DSH**：DSH 自家工具行的文字与图标走 `--dsw-alias-label-tertiary`（#81858c，13px），状态才用颜色。本插件此前用品牌蓝菱形 + 正文色标题，在一片灰里过于显眼；现在改成同档：
  - 图标、名词、分隔 `·`、摘要一律 tertiary 灰（`C.tertiary`，带回退 `#81858c`）；悬停或展开才提到正文色（`C.text`），错误才用错误色，进行中降透明度。
  - 14 个 `ink_*` 各配一个语义描边小图标（`INK_ICONS`，14×14、`stroke: currentColor`、线宽 1.25）：总览=仪表、开环=回环、事实卡=卡片、收件箱=托盘、派发=出箭、提交门=勾、交接=信封、换纪元=旗、草稿=笔、问 Ink=问号、交结论=上传、鱼骨=分支、折叠=归档、回溯=时钟。认不出的工具名退回菱形。
  - 命令行同步：标签/细节 tertiary 灰、12px，状态点平时 tertiary，错误才红。
- **鱼骨「消失」的真因与修复**：不是数据没了，是滚动位置——(a) 会话壳的滚动容器（`.wSkVaW_scrollBody`）在页签切换时沿用「对话」的阅读位置，进入 MiOpIIk 时把视图区顶起几十像素，鱼骨的统计行与图例正好被页签栏切掉；(b) 画布内部滚动容器（`maxHeight: calc(100vh - 250px)`）若停在靠下的位置，可视区落在空白段。修法：进入本视图时把壳的滚动容器 `scrollTop` 归零（只归零这一次，不写壳状态、不改壳元素），画布内部容器挂载时归零、数据变化时把越界滚动夹回。另把行距 34→26、节点尺寸随之下调（回合点 r=4.5、事件圆 6.5/5.5、任务方 13/11、菱形 7），同一画布 71 行从 2510px 收到 1910px，一屏多读近一倍的轮次。
- **「同时刻事件聚簇」的处理**：聚簇要按时间桶合并行，实测本会话 2 秒桶里 Mind 一条道最多挤 5 个动作，硬合并会重叠；先用收紧行距解决同一件事（空白多、一屏读得少），真·聚簇（换布局算法、允许同排多节点微偏移）留作下一步，未硬做。
- 佐证：`test/miopiik-views-ui.test.js` 新增 1 项「工具行配色与 DSH 自家工具行同档：tertiary 灰、悬停提亮、语义图标各不相同」；浏览器复核 1280×720 / 1440×900 与深浅两模式：工具行与 DSH 自家行同色同字号，鱼骨顶部统计行与图例完整可见、画布从顶上开始。

补记时实测（2026-11-22）：全量 `node --test` 227 项全绿（§13.11 基线 226 + 本批 1）。

### 13.13 鱼骨聚簇：一行 = 一轮（2026-11-23）

> 用户反馈鱼骨「一屏读不到几轮」。实测本会话 71 条时间轴项（16 轮 + 15 条事件 + 40 条 Mind 手笔）占 1818px，一屏（约 450px）只读得到五六轮。根因是「一条账目 = 一行」：一轮里 Mind 的十几个动作各自占一行，画布被碎动作拉长。本节把行的粒度从「一条」换成「一轮」。

- **布局规则**（`client.js` FishboneView）：先把时间轴按 `graph.turns` 的 `at` 分派到「锚轮」——轮次项归自己，事件与 Mind 手笔归「时间上不晚于它的最近一轮」（早于首轮的进 `pre` 行）；一行 = 一轮。行内不同泳道并排（各占自己的 x，互不遮挡），**同一泳道内按发生顺序上下微偏移 12px**，行高 `max(26, 26 + 12×(该行最深堆叠 − 1))`。轮点、事件圆/方、菱形、fork/merge 弧、跨道共享事实线全部按各自的行内 y 落点，所以「第几轮发生什么」不变，只是同一轮的碎动作收进同一行。
- **轴的语义**：竖轴仍是时间序（行按轮次时间升序），但行内不再按时间比例——头部标注从「时间 ↓」改成 `graph.axisDown`「轮次 ↓（行内按发生顺序）」，中英双语，不假装行内还是等距时间轴。
- **Mind 泳道换位**（修订 §13.10 的「脊右分支左」）：聚簇后脊右侧紧挨着该轮的用户原话，菱形留在原位置会跟文字打架；Mind 泳道移到**分支区右侧的独立窄道**（`MIND_COL = 56`），形状语言不变（菱形 = Mind 动作），`W` 相应加宽一列。`laneW` 计算扣除 `MIND_COL`，宽屏下分支道仍摊开。
- **实测收益**（真账本 session-cd9aaeff，2026-11-23）：同一批数据 1818px（一条一行）→ 1614px（按时间 2 秒桶聚簇，收益仅 11%，因为 Mind 动作时间上是散的）→ **878px（一行 = 一轮，−52%）**；17 行里每行 1–9 个动作，最近几轮（26–30）一屏可读全。测试桩上同样验证（新增用例断言 `H < 条目数 × 26`，且每轮 Mind 菱形不越出本行）。
- 边界：只动客户端布局计算；`graph` 载荷（turns / events / mindEvents / links）形状与口径一律不变，host 侧零改动。
- 佐证：`test/miopiik-views-ui.test.js` 新增「鱼骨：聚簇布局——一行 = 一轮，同轮动作收进同一行，画布显著变短」；既有 Mind 泳道测试的位置断言按换位更新（菱形 x 现在在分支道右侧）；浏览器复核 1280×720 深浅两模式。

补记时实测（2026-11-23）：全量 `node --test` 228 项全绿（§13.12 基线 227 + 本批 1）。
