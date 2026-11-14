# MiOpIIk Agent 发布说明

本仓库发布单包 `miopiik-dsh`（DSH Web 的 host 侧插件，含 Mind / Ink / Operator 三层）。界面渲染由独立的 `miopiik-iui` 包提供；本包不依赖 `miopiik-iui`，也不内置 IUI 渲染器。

## miopiik-dsh 0.1.1 — stable

**状态**：stable（可独立打包与安装）。

- **修复打包配置**：在 `package.json.files` 中补齐 `host/`，解决此前从 tarball 安装时 `import './host/engine.js'` 缺失文件的问题（0.1.1 发布资产为 29 个文件；当前 main 的打包检查为 30 个，新增了中文 README）。
- **补齐包元数据**：完善 `repository`、`homepage`、`bugs`、`keywords`，移除 `private` 标记。
- **补齐仓库文档**：新增 `README.md`、`README.zh-CN.md` 与 `LICENSE`。
- **新增发布与安装工具**：
  - `tools/check-release.mjs`：执行真实 `npm pack`，比对解包清单与运行时 import 图，校验语法、图标规范、包体积与版本策略。
  - `tools/install-plugin.mjs`：支持 `link` 与 `tarball` 两种安装模式，默认 dry-run。
  - `tools/icon-check.mjs`：校验 `icon.svg` 规范（可选与设计原稿逐字节比对）。
- **图标导出**：按 DSH icon 规范通过 `package.json` 的 `./icon` 导出 `icon.svg`。
- **拆分至独立仓库**：原 monorepo 中 `miopiik-dsh/` 的内容上移至仓库根（`package.json` 与 `index.js` 同级），保留连续 git 历史与全部旧 tag；包名、版本号与安装命令不变。迁移说明见 [MIGRATION.md](MIGRATION.md)。

**兼容性**：DSH 0.2.1-rc.5（测试基线）、Node >= 23.6、仅 DSH Web（web profile）；不依赖 `miopiik-iui`，可单独安装。

**安装**（安装后需重启对应 profile 的 DSH 进程）：

```
dsh plugin --profile <name> add ./miopiik-dsh-0.1.1.tgz
```

或使用仓库内的安装脚本：

```
node tools/install-plugin.mjs --profile <name>            # dry-run，打印将执行的命令
node tools/install-plugin.mjs --profile <name> --execute  # 执行安装
```

**验证**：

```
npm test           # 单元、结构与发布回归测试
npm run check      # 发布就绪检查（输出 JSON 报告）
npm run build:check
npm run icon:check
```
