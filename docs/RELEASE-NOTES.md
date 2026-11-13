# MiOpIIk Agent 发布说明

本仓库只包含一个包：`miopiik-dsh`（DSH Web 的 host 侧插件，Mind / Ink / Operator 三层）。
界面渲染由独立的 `miopiik-iui` 包提供，本包不依赖它，也不含 IUI 渲染器。

## miopiik-dsh 0.1.1 — stable

**状态**：达到可独立发布标准（stable），不需要行为变更。

- **修复打包阻塞**：`package.json.files` 之前漏掉 `host/`，从 tarball 安装会在
  `import './host/engine.js'` 处失败。现已包含全部运行时文件（打包检查实测 29 个文件）。
- 补齐元数据：`repository` / `homepage` / `bugs` / `keywords`，移除 `private`。
- 新增 `README.md`、`LICENSE`。
- 新增发布检查工具 `tools/check-release.mjs`：真实 `npm pack` 后比对打包清单与运行时 import 图、
  校验图标规范、tarball 内容、体积与版本策略；`tools/install-plugin.mjs` 支持 link / tarball
  两种安装方式并默认 dry-run；`tools/icon-check.mjs` 做图标静态校验（可选与设计原稿逐字节比对）。
- 图标按 DSH 官方 icon 规范经 `package.json` 的 `./icon` 导出，保留用户设计原稿的渐变与遮罩。
- **拆分到独立仓库**：monorepo 里的 `miopiik-dsh/` 内容上移到仓库根，仓库根即包根
  （`package.json` 与 `index.js` 同级）；保留连续 git 历史与全部旧 tag，包名、版本与安装方式不变。
  旧 monorepo 的 Release / 下载链接继续有效，迁移细节见 [MIGRATION.md](MIGRATION.md)。

**兼容性**：DSH 0.2.1-rc.5（测试基线）、Node ≥ 23.6、仅 DSH Web（web profile）；
不依赖 `miopiik-iui`，可单装。

**安装**（安装后需重启对应 profile 的 DSH 进程才生效）：

```
dsh plugin --profile <name> add miopiik-dsh
```

在本仓库内也可以先用安装脚本演练，确认后再真正执行：

```
node tools/install-plugin.mjs --profile <name>            # dry-run，只打印将执行的命令
node tools/install-plugin.mjs --profile <name> --execute  # 真正安装
```

**验证**：

```
npm test           # 单元/结构/发布回归
npm run check      # 发布就绪检查（JSON 报告）
npm run build:check
npm run icon:check
```
