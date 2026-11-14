# MiOpIIk 实现映射（SPEC → 代码）

> 对照 [SPEC.md](../SPEC.md) 的条款，列出当前实现位置与状态。
> 状态：`[OK]` 已实现并验证 ｜ `[PARTIAL]` 部分实现 ｜ `[TODO]` 未实现（见 SPEC §11）。

| SPEC | 实现位置 | 状态 |
|---|---|---|
| §1.1 用户只与 Mind 说话 | `host/prompt.js` 章程；`host/tools.js` 无向对话写内容的路径 | `[OK]` |
| §1.2 观测/决定不互写 | `host/store.js`（观测、note、jobs、briefings 分文件） | `[OK]` |
| §1.3 双鱼骨 = 同一日志两个分辨率 | 观测日志 + L3；分支 = 鱼骨分支（`branches.js`、`ink_branch`、切片渲染） | `[OK]` 分支/切片/汇回均已实测 |
| §1.4 Ink 不阻塞前台 | `engine.enqueue` 串行化、`operator` 异步回调 | `[OK]` |
| §1.5 主动终点是收件箱 | `engine.deliverNote` → `inbox.jsonl`；`tools.ink_inbox` | `[OK]` |
| §1.6 自答带引用 | 章程 + `notes.danglingRefs`；无自动出口校验 | `[PARTIAL]` |
| §1.7 闸门按 commit | `tools.ink_commit` → `ctx.userQuestions.ask` | `[OK]` |
| §1.8 Mind 窄工具面 | `INK_TOOL_NAMES`；子 agent `tools.restrict` | `[OK]` |
| §1.9 派发门槛 | `host/contract.js` 六要素校验 | `[OK]` |
| §1.10 无人值守不 commit | `ink_commit` 检查本轮真人输入 | `[OK]` |
| §1.11 结构硬、判断软 | 无行为阈值；仅设容量与 schema 约束 | `[OK]` |
| §1.12 无损存储、有损上下文 | JSONL 落盘 + L3 只放摘要 | `[OK]` |
| §2.1 观测日志 | `engine.observe` + `store.observations`（只收 `source.kind=user`） | `[OK]` |
| §2.2 note 字段与 kind | `host/notes.js`；`engine.deliverNote`；`host/details.js` hash 索引 | `[OK]` |
| §2.2 判决缓存 | `notes.findVerdict` | `[PARTIAL]` 无调用方 |
| §2.3 三份记忆 | 叙事=DSH 会话；开环=`loops`；事实=`facts` | `[OK]` |
| §2.4 判例 | `host/cases.js` + `engine.recordCase/listCases` | `[OK]` 确定性匹配，可引用 |
| §2.5 草稿区 | `engine.addDraft/settleDraft/expireDrafts`；`tools.ink_draft`；抽屉展示 | `[OK]` |
| §3.1 编译 | `host/compile.js`（`ctx.llm` 单次调用 + JSON 解析 + 降级） | `[OK]` |
| §3.1 两级翻译 | 第一级在 `compile.js`；第二级由 Mind（章程） | `[OK]` |
| §3.2 自答/上报 | `engine.answerOperatorQuestion`（判例→事实卡→上报）；`tools.ink_ask` | `[OK]` 三态实测 |
| §3.3 收件箱分层 | `host/inbox.js`（T0–T3、stale、merge、字符预算） | `[OK]` |
| §3.3 预览 = 状态+连接点+问题 | `compile.js` JSON 契约；`loops.asQuestion` | `[OK]` |
| §3.4 守夜 | `operator.js` 超时与无进展检测 → `[阻塞]` 预览 | `[OK]` |
| §3.5 回滚 > 打补丁 | — | `[TODO]` |
| §4.1 闸门只要求判断 | `ink_commit` 行/不行 + 自定义文本回传 | `[OK]` |
| §4.1 契约与验收样例 | `contract.js` | `[OK]` |
| §4.1 早期形状检查 | 写入 Operator 提示词 | `[PARTIAL]` |
| §4.1 验产物不验过程 | Ink 只读取 `activation.result.output` | `[OK]` |
| §4.2 纠错 | `engine.recentUtterances` + `compile` 的 contradicts 标记 → 「更正候选」note | `[PARTIAL]` 最近窗口，无持久链接 |
| §4.3 开环六型/生命周期/老化/上限 | `host/loops.js` + `engine` | `[OK]` |
| §4.4 派发自检 | `contract.js` + `ink_dispatch` 拒绝 | `[OK]` |
| §4.5 展示 | 无硬阈值；由章程与节奏信号引导 | `[PARTIAL]` |
| §4.6 上下文布局 / 缓存 | L3 在 prompt context；DSH 负责前缀缓存 | `[PARTIAL]` |
| §5.1 三种折叠 | 开环老化 + 简报；叙事折叠=DSH compaction | `[PARTIAL]` |
| §5.2 收工/硬断 | `detectGap`/`foldDay` 事后折叠 + L3 断点横幅；收工手动触发 | `[PARTIAL]` 自动收工未做 |
| §5.3 交接简报 | `saveBriefing`（单屏上限）/ `appendBriefingUpdate` / L3 隔夜置顶与更新 | `[OK]` |
| §5.4 隔夜三不变式 | 无自动 commit；Ink 不写对话；挂起不猜（章程） | `[PARTIAL]` |
| §5.5 开工 | L3：简报 → 开环 → 收件箱 | `[OK]` |
| §5.6 天轴老化 | `loops.ageLoops`（2/7 天） | `[OK]` |
| §5.6 草稿老化 | `engine.expireDrafts`（7 天） | `[OK]` |
| §6 产品面 | `client.js` 会话视图与右栏面板；`index.js` projection + `host/commands.js` 干预命令 | `[OK]` 数据与干预实测 |
| §9 术语表 | `client.js` 文案 | `[OK]` |
| §10 验收 1–8 | 见 SPEC §11.3 | `[PARTIAL]` 5 项已实测，跨天 3 项由单测覆盖 |

## 数据文件

```
<workspace>/.dsh/miopiik/
  sessions/<sessionId>/
    observations.jsonl   # 观测：user / assistant / turn-end / fold
    loops.jsonl          # 开环 op：create / touch / status / close / drop
    facts.jsonl          # 事实 op：add / revise / invalidate
    notes.jsonl          # 决定账
    inbox.jsonl          # 投递与状态：deliver / read / star / unstar / defer / supersede
    jobs.jsonl           # 派发：create / update
    drafts.jsonl         # 草稿
    cases.jsonl          # 判例
    branches.jsonl       # 鱼骨分支
    folds.jsonl          # 两阶段折叠记录
    briefings.jsonl      # 交接简报
    details.jsonl        # 详情索引
    ink-context.jsonl    # 中间层连续上下文
    ink-debug.jsonl      # 调试记录
    widgets.jsonl        # 历史展示记录（只读兼容）
    details/<hash>.txt   # 详情正文
  shared/
    facts.jsonl          # 工作区级共享事实
```
