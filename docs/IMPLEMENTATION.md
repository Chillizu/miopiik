# MiOpIIk 实现映射（SPEC → 代码）

> 对照 [SPEC.md](../SPEC.md) 的条款，给出当前实现位置与状态。
> 状态：✅ 已实现并验证 ｜ 🟡 部分实现 ｜ ⬜ 未实现（见 SPEC §11）。

| SPEC | 实现位置 | 状态 |
|---|---|---|
| §1.1 用户只与 Mind 说话 | `host/prompt.js` 章程；`host/tools.js` 无向对话写内容的路径 | ✅ |
| §1.2 观测/决定不互写 | `host/store.js`（观测、note、jobs、briefings 分文件） | ✅ |
| §1.3 双鱼骨 = 同一日志两个分辨率 | 观测日志（`observations.jsonl`）+ L3（`engine.l3Text`） | 🟡 无显式「两个视图」抽象 |
| §1.4 Ink 永不阻塞 | `engine.enqueue` 串行化、`operator` 异步回调 | ✅ |
| §1.5 主动终点是收件箱 | `engine.deliverNote` → `inbox.jsonl`；`tools.ink_inbox` | ✅ |
| §1.6 自答必须带引用 | 章程 + `notes.danglingRefs`；无自动出口校验 | 🟡 |
| §1.7 闸门按 commit | `tools.ink_commit` → `ctx.userQuestions.ask` | ✅ |
| §1.8 Mind 窄工具面 | `INK_TOOL_NAMES`；子 agent `tools.restrict` | ✅ |
| §1.9 派发门槛 | `host/contract.js` 六要素校验 | ✅ |
| §1.10 无人值守不 commit | 章程约定；无提交路径（当前没有自动 commit） | 🟡 无强制 |
| §1.11 结构硬、判断软 | 无行为阈值；只有容量与 schema | ✅ |
| §1.12 无损存储、有损上下文 | JSONL 落盘 + L3 只放摘要 | ✅ |
| §2.1 观测日志 | `engine.observe` + `store.observations`（只收 `source.kind=user`） | ✅ |
| §2.2 note 字段与 kind | `host/notes.js`；`engine.deliverNote` | 🟡 detail hash/索引未做 |
| §2.2 判决缓存 | `notes.findVerdict` | 🟡 无调用方 |
| §2.3 三份记忆 | 叙事=DSH 会话；开环=`loops`；事实=`facts` | ✅ |
| §2.4 判例 | `findVerdict` | ⬜ 无 Operator↔Ink 问答通道 |
| §2.5 草稿区 | `briefingMaterials.drafts` 恒空 | ⬜ |
| §3.1 编译 | `host/compile.js`（`ctx.llm` 单次调用 + JSON 解析 + 降级） | ✅ |
| §3.1 两级翻译 | 第一级在 `compile.js`；第二级由 Mind（章程） | ✅ |
| §3.2 自答/上报 | 章程 + `compile` 只产出预览不叙事 | 🟡 |
| §3.3 收件箱分层 | `host/inbox.js`（T0–T3、stale、merge、cap 3） | ✅ |
| §3.3 预览 = 状态+连接点+问题 | `compile.js` JSON 契约；`loops.asQuestion` | ✅ |
| §3.4 守夜 | `operator.js` 超时 → `[阻塞]` 预览 | ✅ |
| §3.5 回滚 > 打补丁 | — | ⬜ |
| §4.1 闸门只要求判断 | `ink_commit` 行/不行 + 自定义文本回传 | ✅ |
| §4.1 契约与验收样例 | `contract.js` | ✅ |
| §4.1 早期形状检查 | 只写进 Operator 提示词 | 🟡 |
| §4.1 验产物不验过程 | Ink 只看 `activation.result.output` | ✅ |
| §4.2 纠错（Mind 的承诺也是 claim） | 未实现 utterance→claim 链接 | ⬜ |
| §4.3 开环六型/生命周期/老化/上限 | `host/loops.js` + `engine` | ✅ |
| §4.4 派发自检 | `contract.js` + `ink_dispatch` 拒绝 | ✅ |
| §4.5 展示 | 无阈值；章程约束 | 🟡 无信号面板 |
| §4.6 上下文布局 / 缓存 | L3 只在 prompt context；无显式 L0–L5 组装 | 🟡 DSH 负责前缀缓存 |
| §5.1 三种折叠 | 开环老化 + 简报；叙事折叠=DSH compaction | 🟡 |
| §5.2 收工/硬断 | `ink_brief save`（Mind 显式） | 🟡 无自动检测 |
| §5.3 交接简报 | `engine.saveBriefing` / `latestBriefing`；L3 隔夜置顶 | ✅ |
| §5.4 隔夜三不变式 | 无自动 commit；Ink 不写对话；挂起不猜（章程） | 🟡 |
| §5.5 开工 | L3：简报 → 开环 → 收件箱 | ✅ |
| §5.6 天轴老化 | `loops.ageLoops`（2/7 天） | ✅ |
| §5.6 草稿老化 | 无草稿 | ⬜ |
| §6 产品面 | 存在感/抽屉/两个页面（占位） | 🟡 页面无数据通道 |
| §9 术语表 | `client.js` 文案 | ✅ |
| §10 验收 1–8 | 见 SPEC §11.3 | 🟡 4/8 可自动验证 |

## 数据文件

```
<cwd>/.dsh/miopiik/<sessionId>/
  observations.jsonl   # 观测：user / assistant / turn-end / fold
  loops.jsonl          # 开环 op：create / touch / status / close / drop
  facts.jsonl          # 事实 op：add / revise / invalidate
  notes.jsonl          # 决定账
  inbox.jsonl          # 投递与状态：deliver / read / star / unstar / defer / supersede
  jobs.jsonl           # 派发：create / update
  briefings.jsonl      # 交接简报
```
