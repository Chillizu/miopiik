# 支持矩阵

| 项 | miopiik-dsh (Agent) | miopiik-iui (IUI) |
|---|---|---|
| 包类型 | 独立可安装的 DSH 插件包 | 独立可安装的 DSH 插件包 |
| 当前版本 | 0.1.1（可发布） | 0.1.0-rc.4（预发布） |
| 依赖另一个包 | 否 | 否（运行时可与 Agent 同装或单装） |
| Tarball 安装 | 支持（`files` 已含 `host/`、`shared/`） | 支持 |
| 运行中 profile 安装 | 需重启后生效 | 需重启后生效 |
| DSH 测试基线 | 0.2.1-rc.5 | 0.2.1-rc.5 |
| Node | ≥ 23.6 | ≥ 23.6 |
| 平台 | web（DSH Web GUI） | web（DSH Web GUI） |
| 宿主补丁依赖 | 无 | **内联渲染需要实验性 chat 包补丁**；未打补丁时仅设置页预览可用 |
| 数据写入 | 只写自己的会话日志/图表目录 | 不写任何日志；浏览器 localStorage 保存一个渲染偏好 |

## IUI 的"内联渲染"额外条件

IUI 的聊天内嵌能力依赖对 `@deepseek-ai/dsh-client-ui-chat` 的实验性 patch
（见包内 `patches/chat-markdown-embeds.patch` 与 `tools/fork-chat-embeds.mjs`）。
这是**非官方支持的安装方式**，因此 IUI 保持 rc；未打补丁时：

- 设置页、示例、复制、诊断全部可用；
- 聊天里的 `iui` 围栏按普通 Markdown 代码块显示（不报错、不吞正文）；
- 设置页诊断会显式显示"未检测到补丁"。

## 已知限制

- 行内标记跨 Markdown 语法（如跨越 `**加粗**`）时会在标记处断开，复制可能带出额外换行。
- 流式期间未闭合的 `iui` 围栏按原文显示，闭合后一次性物化。
- 旋转/缩放后的主题切换依赖 DSH 刷新；插件不主动改宿主主题。
