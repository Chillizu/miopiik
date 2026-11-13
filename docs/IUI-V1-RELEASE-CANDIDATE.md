# MiOpIIk IUI v1 — 稳定候选基线与交付门禁

> 初稿 2026-11-12，更新 2026-11-13。范围是独立 **MiOpIIk IUI**，不等于整个 Mind–Ink–Operator 架构版本发布。
> 当前结论：**实验性稳定候选（RC）**；尚未满足“所有 DSH 用户默认启用”或“原生 Markdown 完全无损”标准。
> 以 Git HEAD、运行环境和每次重新执行的测试结果为准，不把本文件当作永久健康证明。

## 1. 落定的技术边界

- **模型面向表达**：`miopiik-ml`（`\`\`\`iui` 围栏）作为首选候选，JSON AST 保留调试/兼容入口。两者统一进入 `iui/1` AST、`validateAst` 和受控 React 组件注册表；禁止任意 HTML/CSS/JS。
- **模型输出的样式权限**：仅语义 tone、有限布局 token、数据、状态初值和安全绑定；主题、间距、颜色、事件处理、安全限制由可信客户端负责。
- **局部状态**：`$state.foo.bar` 和 `$data.foo.bar` 是受限读取路径，不允许脚本表达式；交互仅允许声明式本地变更，不代表获得外部执行或写入授权。
- **聊天层所有权**：DSH 原生 `AssistantMarkdown` 与 `ReasoningRow` 负责消息、思考折叠、图片和历史；独立的 `miopiik-iui` 插件只呈现受信 inline token 与 fenced `iui` 片段。MiOpIIk Agent 已撤出聊天整行接管。
- **部署实现**：当前是本地 `dsh-client-ui-chat` fork 和 Web profile 专用覆盖链接，**不是已经合并进 DSH 上游的正式 API**。安装/回滚详情见 [UPSTREAM-MARKDOWN-EMBED.md](UPSTREAM-MARKDOWN-EMBED.md)。
- **旧展示工具退役**：`ink_view` / `ink_chart` 已从 MiOpIIk 的工具注册中撤下，旧整行接管入口也已取消。历史会话与 `widgets` 账本原始文件保留；不承诺继续渲染旧 Widget，也不在 IUI 发布包内附带旧协议。

## 2. 已验证的 RC 能力

| 维度 | 证据/边界 |
|---|---|
| 真实画廊兼容 | 原始三份 `iui` 样本固定为 `test/fixtures/gallery/`，解析、校验无非预期降级 |
| 行内表达 | badge / icon / code 等受信 token，复合 paragraph、card、grid、table、chart、metric |
| 表格 | 列描述符 + 对象行兼容，历史二维数组兼容，真实回放不出现 `[object Object]` |
| 状态 | `state name/value` 兼容；本地 segmented 切换能更新绑定的指标和图表，无额外模型消息 |
| 原生渲染 | 在 fork 启用下，旧画廊会话回放显示三展区；原生 ReasoningRow 有效展开和折叠 |
| 错误隔离 | 受限标签与 AST 校验、非法局部降级，原生 Markdown 主路径不由 MiOpIIk 整体替换 |

上述事实的回归脚本：

```sh
npm test
node miopiik-iui/tools/fork-chat-embeds.mjs --check
node tools/e2e-gallery-replay.mjs
node tools/e2e-iui-user-sessions.mjs
node tools/e2e-playwright.mjs
node tools/e2e-dual-settings.mjs
```

后四项需要正在运行的本地 DSH Web、相应的受控测试环境和隔离 Playwright 浏览器。**脚本严禁发送模型测试消息到既有主会话**；画廊回放脚本只读打开旧会话并在测试浏览器内部点击状态控件。

### 交付阻断项（必须全部满足才可称“该 RC 验收通过”）

1. `npm test` 全绿、fork `--check` 通过、工作树变更可审计。
2. 真实画廊：恰有三个 `data-iui-output`，表格 / 状态标签 / 指标完整，无非预期降级或 JS 错误。
3. 本地切换：真实 DOM 点击后 7 日 `12,480` → 30 日 `48,296`，不新增消息；不能只检测按钮存在。
4. 原生思考折叠：真实 `[data-variant=think] [role=button]` 的 `aria-expanded` 能回到原状态。
5. 覆盖 `assistant-step` 的旧实验路径不得意外成为默认；旧会话、旧 `ink-view` 内容不得消失。
6. 服务变更前需确认无 DSH 任务运行，备份配置、检查插件 import 与日志；只有经过明确验收的变更才可重启。
7. **安全审查不能靠绕开认证或平台拦截解决**；未来应改用正式授权的 DSH 会话连接接口，不对历史主会话发送自动化测试消息。

## 3. 明确不在本次 RC 完成范围内

| 项目 | 现状 | 关闭条件 |
|---|---|---|
| AST 级无损行内 Markdown | 仍将文本切成多个 `MarkdownText` 片段，跨 token 加粗、复制、语义朗读可能不完整 | 上游可用 renderer/remark 扩展点，真实选区复制与 a11y 测试 |
| 流式增量 IUI | 未闭合 fence 按普通文本，闭合后一次物化 | 中间状态安全渲染，不闪烁、不重复挂载；流式/中断 E2E |
| 旧工具清理 | `ink_view` / `ink_chart` 停止注册，MiOpIIk Agent 客户端的旧 Widget/DSL/IUI 视图及重复协议已清理；历史数据保持不变 | 保留历史账本备份，不再承诺旧 Widget 的呈现 |
| 新格式模型默认引导 | `miopiik-iui/index.js` 已独立注入精简输出约定，不再依赖 MiOpIIk Agent；同模型 A/B 性能尚未完成 | 对普通问答、图表和交互任务做真实模型多样本合法率/退化/耗时对照 |
| 公共上游集成 | 本地 fork、耦合打包产物和当前 DSH 版本 | 上游源码/API 可用、上游补丁审核及跨版本兼容测试 |
| 长时运行、主题与可访问性全验收 | 已有暗色及窄屏基础测试，但不是完整矩阵 | 浅色/深色/高对比度、键盘、屏幕阅读器、复制、长会话内存与性能测试 |

**结论：目前可用于受控实验/演示与继续开发，不应把“v1 RC”宣传成“生产通用版已完全落定”。**

## 4. 保守启用与回滚

- `0.1.0-rc.3` 安装独立插件后默认开启受信 IUI 嵌入；从 **DSH → 插件 → 已安装 → miopiik-iui** 的配置页查看状态、切换开关和测试实时预览。开关保存在当前浏览器。
- 旧整行正文接管与旧 DSL 预览已从 MiOpIIk Agent 客户端移除；不再提供旧配置开关。
- **快速撤回**：在 IUI 插件配置页关闭渲染（对应本浏览器 `miopiik.markdownEmbeds=0`），刷新即可回到原生 Markdown，不改历史消息。
- **完整回滚**：按 [部署说明](UPSTREAM-MARKDOWN-EMBED.md) 恢复 Web profile 的 `ui-chat` 原依赖解析后再做安全服务重启。不要改全局 DSH 安装或其他 profile 的共享依赖链接。
- fork `--check` 是只读校验；生成器更新可能覆盖正在使用的 fork 目录，**不得在运行环境中随意重建**。

## 5. 下一阶段的有限工作队列

1. **P0：可靠性**——完善 E2E 真正的交互/折叠断言（本次落地）、受限输入的状态与表格安全预算、失败诊断、跨版本 fork 自检。
2. **P1：原生程度**——本轮修复混合 Markdown + IUI 块级组件被压窄的问题（真实两条会话全宽回放已验收）；继续争取 Markdown AST 级 block/inline 扩展、复制与朗读、流式生命周期。
3. **P2：公开发布准备**——独立包现有本地安装、配置页和浅/深色窄屏回归；仍需同模型多场景 benchmark、跨 DSH 版本兼容矩阵及外部发布审查。
4. **P3：推广**——稳定性矩阵、公开文档、原生插件接口，而不是继续无边界扩充 Widget 清单。

旧工具入口已退役，但历史数据不做破坏性删除；未完成的 Markdown 原生性与流式限制必须继续记录。IUI 的定义不变：**让模型以受限声明在聊天中生成恰到好处的界面，其他聊天体验仍属于 DSH。**
