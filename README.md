# MiOpIIk

<img src="docs/images/icon.png" width="96" alt="MiOpIIk icon">

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

**Mind · Ink · Operator** —— 让持续对话与异步行动各自独立，又能自然咬合的 Agent 架构。

`MiOpIIk` 取自 `Mi`(nd) + `Op`(erator) + `IIk`(ink)。把 Ink 藏在词尾，是因为它本来就是隐在中间的那一层。

![架构：一个对话，两条时间线，三层分工](docs/images/report-2026-11-10/architecture.png)

## 它是什么

在这个架构里，只有 **Mind** 面向用户说话。**Ink** 退在中间记账、编译、收拢收件箱、折叠上下文、跨天守夜——它既不对用户开口，也不替对话做决定。**Operator** 在后台干活，只接手切好的上下文切片，干完把结论或失败交回来。

对话走 turn 序列，后台走 job 序列，两条时间线靠中间层对齐。**对话不被后台打断，后台也不必借对话证明自己。**

## 现在能做什么

- **对话主干**：讨论、判断、做决定；悬着的事（开环）只由 Mind 亲手闭合。
- **账本**：`ink-context`、事实卡、开环、收件箱、草稿、简报与任务板，一律以 append-only JSONL 落盘，随时可回放。
- **编译线**：每轮结束后编译候选结论，收拢 Operator 交回的结果，遇上前后矛盾时直接指认到具体哪一句话。
- **后台**：从派发、子 agent 执行、`ink_report` 交回，到任务板结算走通闭环；超时与卡死均可检测。
- **折叠与跨天**：按事件触发折叠，隔夜写好交接简报；第二天再聊时，先承认上次断在哪里，再往下接。
- **所见**：把中间层此刻看到的画面摊开备查——上下文的头与尾、编译出的候选、待读的收件箱。
- **Extra 展示层（可删）**：同一份 `view spec` 可落向四处——正文卡片、独立行、视图页、或由 Host 直接画成 SVG 落盘并以原生图片内嵌的「画像」；协议 v2 自带容量预算、数据出处、动作分级与无障碍兜底。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `miopiik-dsh/` | DSH 插件本体（Host + Client） |
| `test/` | 单测（`node --test test/`） |
| `docs/` | 设计文档、实机验证记录、图文报告、示意图 |
| `SPEC.md` | 规格单一真源 |
| `tools/` | 维护脚本 |

Extra 展示层的**设计与协议**归档在独立仓库 [`miopiik-extra`](https://github.com/Chillizu/miopiik-extra)；实现代码当前仍内联在本仓，下一步会拆出去。

## 安装（DSH workspace bundle）

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: miopiik-dsh
      name: 'miopiik-dsh'
```

把仓库以软链放进对应 profile 的 `plugins` 目录即可，插件自身已带好 `cordis.patch.yml`（`miopiik-dsh/cordis.patch.yml`）。

## 设计原则

1. **中间层不发言**：Ink 的一切产物先落账本，说与不说由 Mind 决定。
2. **后台可失败**：失败也是合法结果，必须走交回语义，不能悄悄蒸发。
3. **展示可删**：Extra 整层随时可拆，拿掉之后主干照常运转。
4. **不把 UI 当审批**：屏幕上画了按钮不代表用户已经点头；真正写入仍要回到带权限与审计的通道。
5. **账本先于对话**：状态留在日志里，而不是寄存在上下文里。

## 文档

- [SPEC.md](SPEC.md) —— 规格（单一真源）
- [docs/REPORT-2026-11-10.md](docs/REPORT-2026-11-10.md) —— 技术与理念报告（图文）
- [docs/EXTRA-UI.md](docs/EXTRA-UI.md) —— Extra 展示层：协议、落点、对齐说明
- [docs/ALIGNMENT-AUDIT.md](docs/ALIGNMENT-AUDIT.md) —— 自审计与偏差登记
- [docs/machine-test-2026-11-06.md](docs/machine-test-2026-11-06.md) —— 实机验证记录

## 状态

`v0.1.x`（当前 `v0.1.3`）—— 可安装，编译线与后台线均已跑通；尚未发布到 npm，接口与账本格式仍在演进中。

## License

MIT
