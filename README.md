# MiOpIIk

**Mind · Ink · Operator** —— 让持续对话与异步行动相互独立、又能自然协作的 Agent 架构。

- **Mind**（M）：对话主干，叙事权威与注意力。用户始终只与它交流。
- **Ink**（I）：中间层，外置大脑。编译、校验、记账、收件箱、折叠、判例、守夜。它不"想"，它编译。
- **Operator**（O）：普通 agent，可递归，在后台干活。用户看不见它。

> `MiOpIIk` = `Mi`(nd) + `Op`(erator) + `IIk`(ink)。Ink 藏在词尾——因为它本来就是隐身的那个层。

## 文档

- **规格（单一真源）**：[SPEC.md](SPEC.md)

## 实现形态

一个 DSH（DeepSeek Harness）插件：`miopiik-dsh/` 是 workspace bundle，以 link 方式装进 `web` profile。
Host 侧用 `sessionProjections` / `storageDomain` / `ctx.llm` / `subagents`；Client 侧用 `composer.dock`（存在感）、`shell.overlay`（抽屉）、`sidebar.panellist` + `main`（两个页面）。

## 阶段

| 批次 | 内容 | 状态 |
|---|---|---|
| 0 | SPEC.md + 仓库骨架 | 完成 |
| 1 | bundle 骨架 + 存在感指示 + 抽屉 + 占位页，可安装可见 | 完成（界面验收待重启后确认） |
| 2 | Ink 确定性核心：观测日志、账本、开环老化、收件箱分层、L3、窄工具面、23 项单测 | 完成 |
| 3 | 判断层：LLM 编译、Operator 派发、commit 闸门、Operator↔Ink 问答与判例 | 完成 |
| 4 | 折叠与跨天：简报、隔夜更新、硬断承认、开工恢复 | 完成 |
| 5 | 五个用户面（悬着的事/我们一起定的/后台在跑/草稿/今天的信）+ 审计视图 | 完成；设置页待办 |

## 开发

```sh
# 语法检查
node --check miopiik-dsh/index.js
node --check miopiik-dsh/client.js

# 单元测试（纯逻辑）
node --test test/
```

插件已以 link 方式挂在 profile 中（`~/.dsh/profiles/web/package.json`），改动后刷新页面 / 重启 dsh 生效。
