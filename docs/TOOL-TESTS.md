# 工具点测记录（2026-11-04）

对象：`miopiik-dsh` 在**运行中**的插件上暴露的 12 个模型工具。
方式：每个工具都做真实调用，记录返回；不只看 schema。
运行环境：会话 `session-0014d101`，工作区 `/home/data/Projects/Mio/MiOpIIk`。

## 结果

| 工具 | 动作 | 结果 | 证据 |
|---|---|---|---|
| `ink_status` | 读取 | 通过 | `epoch 1 / day 20761 / observations 759 / closed 12 / facts 4 active 1 stale / notes 15` |
| `ink_loops` | add / get / touch / close / drop / list | 通过 | L-12 `add→get→touch→close`（`closedBy: mind`）；L-13 `drop`（`status: dropped`） |
| `ink_facts` | add / revise / invalidate / list | 通过 | F-5 `add→revise`（claim 当场变为「已修订」，`revisedAt` 更新）→`invalidate`（`stale: true` + 原因） |
| `ink_inbox` | list / open / star / unstar / read | 通过 | I-13 由 B-7 汇回真实产生；`open` 取回 note + 全文；star→unstar→read 状态依次正确 |
| `ink_epoch` | advance | 通过 | `0 → 1`；旧预览随即从 T1 降到 T2（stale 只降一级） |
| `ink_brief` | materials / latest | 通过 | materials 汇总活跃开环、在跑任务、草稿、收件箱计数；latest 返回当日五段交接 |
| `ink_draft` | add / list / drop | 通过 | P-3 `add→list→drop`（`status: dropped`，`settleReason: mind:dropped`） |
| `ink_branch` | open / get / context / summary / merge / abandon | 通过 | B-7 `open`（带前提+引用）→`context`（补 F-5 依赖）→`get`（切片文本含前提与引用）→`merge`（产出 D-15 预览，`mergedInto: D-15`）；B-6 `abandon`（`status: abandoned`） |
| `ink_fold` | propose / review / reject | 通过 | A-8 `propose`（1201 字档案，覆盖 40/100）→`review`（problems 为空）→`reject`（`settled: rejected`、`contextReplaced: false`、`reason: rejected-by-mind`） |
| `ink_recall` | query / branch / read | 通过 | 「点测」命中 5 条（note/fact/utterance/branch 四类混合）；按分支 B-7 命中 20 条 |
| `ink_dispatch` | draft:true（只给 goal） | 通过 | J-8 派出，`draft:true` 时只要求一句话目标；契约模式缺要素会被拒（此前 J-1 已验证） |
| `ink_commit` | confidence=low | 通过（拒绝路径） | 直接报「低置信不提交：留在草稿区」，**没有弹到用户面前**——符合预期；交互路径需真人应答，未自动点测 |
| `ink_ask` | — | 按设计不可见 | Mind 的工具面里没有它；仅 Operator 子会话可用（`INK_TOOL_NAMES` 之外的唯一例外，有守卫测试） |

## 点测中发现并修掉的两个真 bug

1. **修订事实时本会话视图没同步**：写进共享文件后 `listFacts()` 仍返回旧 claim。修法：共享写入后用 `applyRecord` 同步会话视图。
2. **事实 id 撞号**：共享写入路径没推进计数器，两次 `add` 都拿到 `F-1`，后者覆盖前者。修法同上（`applyRecord` 会推进计数）。

两条都补了回归测试；全套 109 项测试通过。

## 未覆盖的部分（说明，不隐瞒）

- `ink_commit` 的交互路径（真正把「行 / 不行」送到用户面前）需要真人应答，自动点测会有长时间挂起风险，故只测了低置信拒绝路径。
- `ink_dispatch` 的完整契约模式此前已用 J-1（六要素）与 J-7（draft）验证；本轮只补 draft 一次。
- `ink_fold approve`（会触发上下文替换）未点测：替换依赖 DSH 的 `/compact`，在 agent 忙碌时会返回失败；已由单测覆盖三种结局。
