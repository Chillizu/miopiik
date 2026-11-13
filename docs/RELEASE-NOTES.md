# MiOpIIk Release Notes

## miopiik-dsh 0.1.1 — releasable

- **修复打包阻塞**：`package.json.files` 之前漏掉 `host/` 与 `shared/`，从 tarball 安装会
  在 `import './host/engine.js'` 处失败。现已包含全部运行时文件（35 个文件）。
- 补齐元数据：`repository` / `homepage` / `bugs` / `keywords`，移除 `private`。
- 新增 `README.md`、`LICENSE`。
- 新增发布检查工具 `tools/check-release.mjs`：打包清单 vs 真实 import 图、图标规范、
  tarball 内容、体积与版本策略。
- 兼容性不变：DSH 0.2.1-rc.5、Node ≥ 23.6；不依赖 `miopiik-iui`。

**结论**：达到可发布标准（0.1.1），不需要行为变更。

## miopiik-iui 0.1.0-rc.4 — pre-release, NOT stable

### 已修复
- 设置页诊断新增宿主补丁状态：打补丁显示"已加载"，未打补丁显示"未检测到补丁 · 仅设置页预览可用"。
- fork 补丁在加载时广播能力标记（`globalThis.__miopiikMarkdownEmbedsHost`）。
- 元数据补齐（`repository`/`homepage`/`bugs`/`keywords`），移除 `private`。

### 为什么仍是 rc，不是 0.1.0 stable
1. **内联渲染依赖非官方 patch**：需要把 profile 里的 `@deepseek-ai/dsh-client-ui-chat`
   替换成本仓库生成的 fork。这不是可发布包能自我声明的安装方式，普通用户按标准流程安装后
   聊天里**看不到**内联 IUI（只看到代码块），与产品承诺不一致。
2. **跨 token 的 Markdown 无损混排未完成**：切分式嵌入会打断跨标记的强调，复制会产生额外换行。
   正解是 Markdown AST 级嵌入，需要 DSH 上游扩展点（提案见 `docs/UPSTREAM-MARKDOWN-EMBED.md`）；
   本机核实 `dsh-client-ui-primitives` 仅以 bundle 形式存在，插件无法 fork。
3. **流式非增量**：围栏闭合后才物化。

### 升级为 0.1.0 stable 的条件（blocker 清单）
- [ ] DSH 提供官方 Markdown embed / renderer 扩展点（或把 primitives 作为可解析包发布）；
- [ ] 或 IUI 的内联能力改为不依赖宿主 patch 的官方机制；
- [ ] 跨 token Markdown 与复制行为达到可接受水平（或文档化为"仅行内原子标记"并默认关闭）；
- [ ] 一次干净的 profile 冷启动安装验证（安装→启动→渲染→卸载）。

在此之前保持 `0.1.0-rc.x`，不发布 stable。
