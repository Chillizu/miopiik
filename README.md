# MiOpIIk

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

**Mind · Ink · Operator** —— 让持续对话与异步行动相互独立、又能自然协作的 Agent 架构。

`MiOpIIk` = `Mi`(nd) + `Op`(erator) + `IIk`(ink)。Ink 藏在词尾——因为它本来就是隐身的那个层。

![架构：一个对话，两条时间线，三层分工](docs/images/report-2026-11-10/architecture.png)

## 它是什么

用户只跟 **Mind** 说话。**Ink** 在中间记账、编译、收件箱、折叠、守夜——它不面向用户，也不"想"。**Operator** 在后台干活，只拿切片，交回结论或失败。

两条时间线：对话是 turn 序列，后台是 job 序列，中间层负责对齐。**对话不被后台打断，后台不靠对话证明自己。**

## 现在能做什么

- **对话主干**：讨论、判断、决定；开环只由 Mind 闭合。
- **账本**：`ink-context` / 事实卡 / 开环 / 收件箱 / 草稿 / 简报 / 任务板，全部 append-only JSONL，可回放。
- **编译线**：回合后编译候选、Operator 结果编译、矛盾指认到具体某句话。
- **后台**：派发 → 子 agent 执行 → `ink_report` 交回 → 任务板结算；超时与卡住可检测。
- **折叠与跨天**：事件驱动折叠、隔夜简报、隔天开工先承认断点。
- **所见**：把中间层此刻看到的东西摊开（上下文头/尾、候选、待读）。
- **Extra 展示层（可删）**：一份 `view spec` 四个落点——正文卡片 / 独立行 / 视图页 / 画像（SVG 落盘，按原生图内嵌）；协议 v2 自带预算、出处、动作分级与无障碍。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `miopiik-dsh/` | DSH 插件本体（Host + Client） |
| `test/` | 单测（`node --test test/`） |
| `docs/` | 设计文档、实机验证记录、图文报告、示意图 |
| `SPEC.md` | 规格单一真源 |
| `tools/` | 维护脚本 |

Extra 展示层的**设计与协议**归档在独立仓库 [`miopiik-extra`](https://github.com/Chillizu/miopiik-extra)；代码当前仍内联在本仓，抽取是下一步。

## 安装（DSH workspace bundle）

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: miopiik-dsh
      name: 'miopiik-dsh'
```

仓库以 link 方式放进 profile 的 plugins 目录，插件自带 `cordis.patch.yml`（`miopiik-dsh/cordis.patch.yml`）。

## 设计原则

1. **中间层不发言**：Ink 的产物先落账本，由 Mind 决定说不说。
2. **后台可失败**：失败也是结果，必须有交回语义。
3. **展示可删**：Extra 整层可拆，删掉主干照样成立。
4. **不把 UI 当审批**：按钮在屏幕上不等于用户同意；写入回到有权限与审计的通道。
5. **账本先于对话**：状态在日志里，不在上下文里。

## 文档

- [SPEC.md](SPEC.md) —— 规格（单一真源）
- [docs/REPORT-2026-11-10.md](docs/REPORT-2026-11-10.md) —— 技术与理念报告（图文）
- [docs/EXTRA-UI.md](docs/EXTRA-UI.md) —— Extra 展示层：协议、落点、对齐说明
- [docs/ALIGNMENT-AUDIT.md](docs/ALIGNMENT-AUDIT.md) —— 自审计与偏差登记
- [docs/machine-test-2026-11-06.md](docs/machine-test-2026-11-06.md) —— 实机验证记录

## 状态

`v0.1.0` —— 可安装、可跑通编译线与后台线；未发布 npm。接口与账本格式仍会变。

## License

MIT
