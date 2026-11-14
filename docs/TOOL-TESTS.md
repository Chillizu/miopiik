# 工具点测记录（2026-11-04）

对象：`miopiik-dsh` 在运行中会话里注册的模型工具。
方式：对每个工具执行真实调用并核对返回值与账本落盘。
运行环境：会话 `session-0014d101`，工作区 `/home/data/Projects/Mio/MiOpIIk`。

## 结果

| 工具 | 动作 | 结果 | 证据 |
|---|---|---|---|
| `ink_status` | 读取 | 通过 | `epoch 1 / day 20761 / observations 759 / closed 12 / facts 4 active 1 stale / notes 15` |
| `ink_loops` | add / get / touch / close / drop / list | 通过 | L-12 `add→get→touch→close`（`closedBy: mind`）；L-13 `drop`（`status: dropped`） |
| `ink_facts` | add / revise / invalidate / list | 通过 | F-5 `add→revise`（claim 更新为修订内容，`revisedAt` 更新）→`invalidate`（`stale: true` + 原因） |
| `ink_inbox` | list / open / star / unstar / read | 通过 | I-13 由 B-7 汇回产生；`open` 取回 note 与全文；`star→unstar→read` 状态流转正常 |
| `ink_epoch` | advance | 通过 | `0 → 1`；旧预览从 T1 降为 T2（stale 降一级） |
| `ink_brief` | materials / latest | 通过 | `materials` 汇总活跃开环、在跑任务、草稿、收件箱计数；`latest` 返回当日五段交接简报 |
| `ink_draft` | add / list / drop | 通过 | P-3 `add→list→drop`（`status: dropped`，`settleReason: mind:dropped`） |
| `ink_branch` | open / get / context / summary / merge / abandon | 通过 | B-7 `open`（含前提与引用）→`context`（追加 F-5 依赖）→`get`（返回切片文本）→`merge`（生成 D-15 预览，`mergedInto: D-15`）；B-6 `abandon`（`status: abandoned`） |
| `ink_fold` | propose / review / reject | 通过 | A-8 `propose`（1201 字档案，覆盖 40/100）→`review`（`problems` 为空）→`reject`（`settled: rejected`、`contextReplaced: false`、`reason: rejected-by-mind`） |
| `ink_recall` | query / branch / read | 通过 | 检索「点测」命中 5 条（涵盖 note/fact/utterance/branch）；按分支 B-7 命中 20 条 |
| `ink_dispatch` | `draft: true`（仅传 `goal`） | 通过 | J-8 成功派发；完整六要素契约模式此前已由 J-1 验证 |
| `ink_commit` | `confidence: "low"` | 通过（拒绝路径） | 返回「低置信不提交：留在草稿区」，未向用户弹出提问框；高置信交互路径需真人点击确认，未纳入自动点测 |
| `ink_ask` | — | 按设计隔离 | 不在 Mind 工具面中；仅对 Operator 子会话开放（有工具面隔离单测覆盖） |

## 点测发现并修复的缺陷

1. **修订共享事实时当前会话内存视图未同步**：写入 `shared/facts.jsonl` 后 `listFacts()` 仍返回旧 claim。已修复：共享写入后调用 `applyRecord` 同步当前会话视图。
2. **共享事实 id 重复**：共享写入路径未推进本地计数器，连续两次 `add` 均分配 `F-1`。已通过同步调用 `applyRecord` 修复。

两项修复均已补充回归测试，全套 109 项测试通过。

## 测试范围说明

- `ink_commit` 的真人交互路径（「行 / 不行」弹窗）需要人工应答，本轮仅自动点测低置信拒绝路径。
- `ink_dispatch` 的六要素契约模式已在 J-1 验证，本轮补充验证 `draft: true` 探索派发。
- `ink_fold approve` 依赖宿主 `/compact` 服务（在当前会话忙碌时无法原地触发压缩），其三种结算分支由单元测试覆盖。
