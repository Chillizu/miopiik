# 迁移说明：monorepo → MiOpIIk Agent 独立仓库

本仓库由 MiOpIIk monorepo 拆分而来。拆分目标是把两个可独立安装的 DSH 插件包
（`miopiik-dsh` / `miopiik-iui`）变成两个可独立 clone / build / `npm test` / `npm pack` / 安装的仓库。
本文件记录本仓库（MiOpIIk Agent，包名 `miopiik-dsh`）的迁移来源、布局变化与兼容性。

## 来源

| 项 | 值 |
|---|---|
| 来源仓库 | [https://github.com/Chillizu/miopiik](https://github.com/Chillizu/miopiik) |
| 公开 main 提交 | `adb12bc` |
| 拆分前本地工作 tip | `332fd84`（IUI 围栏容错修复，尚未 push） |
| 本仓库历史 | 从 monorepo 直接延续：240 个提交、6 个旧 tag 全部保留，历史未重写 |

旧 tag 全部保留：`v0.1.0`、`v0.1.1`、`v0.1.2`、`v0.1.3`（早期 docs 里程碑）、
`miopiik-agent-v0.1.1`；另外 `miopiik-iui-v0.1.0-rc.4` 是 monorepo 里给 IUI 打的 tag，
随历史一起保留，不作为本仓库的发布 tag。

## 布局变化（Agent）

monorepo 里 Agent 包在 `miopiik-dsh/` 子目录；拆分后内容整体上移到仓库根，
**仓库根即包根**（`package.json` 与 `index.js` 同级，不再是 workspace 子目录）。

| 拆分前（monorepo） | 拆分后（本仓库） |
|---|---|
| `miopiik-dsh/package.json` | `package.json` |
| `miopiik-dsh/index.js`、`client.js`、`icon.svg`、`cordis.patch.yml` | 仓库根同名文件 |
| `miopiik-dsh/host/`、`miopiik-dsh/locale/` | `host/`、`locale/` |
| `miopiik-dsh/test/` | `test/` |
| `miopiik-dsh/tools/` | `tools/` |
| `miopiik-dsh/docs/` | `docs/`（`SPEC.md` 在仓库根） |
| `miopiik-iui/**` | 迁出到独立仓库，本仓库不再包含 |
| monorepo 根级 CI / 发布脚本 | 按单包重写后放在本仓库根（`.github/`、`tools/`） |

包名 `miopiik-dsh`、版本 `0.1.1` 与安装命令都不变。**旧 tag、旧 Release 与下载链接不动**：
`miopiik-agent-v0.1.1` Release 及其资产（`miopiik-dsh-0.1.1.tgz`、`SHA256SUMS.txt`）继续有效，
旧仓库 URL 仍是本仓库的主仓库地址。

## 另一个仓库（MiOpIIk IUI）的迁移方式

IUI 用 `git subtree split -P miopiik-iui` 从 monorepo 提取，保留 13 个 IUI 相关提交的真实历史；
split 后提交哈希会重写，原始哈希见来源仓库。随后把仓库级测试、工具、文档、CI 补到新仓库根。
旧仓库的同名 Release（`miopiik-iui-v0.1.0-rc.4`）资产与下载链接继续有效；
新仓库另行发布 `v0.1.0-rc.4` prerelease（IUI 仍是预发布，不是 stable）。

## 历史数据兼容

- 旧的 `ink-view` JSONL / 会话内容**不迁移、不删除**。渲染层由 IUI 的只读 legacy adapter
  把旧七 Widget spec 映射成 `iui/1` AST 回放，历史会话不丢。
- Agent 账本路径不变：workspace 下 `.dsh/miopiik/` 的 append-only JSONL，已安装环境不需要搬家。

## 自托管：把已有 profile 从 monorepo 布局切到本仓库

如果你之前是把 monorepo 的子目录 `link:` 进 DSH profile（而不是从 tarball 安装），
拆分后需要把 profile 的指向切到独立仓库。两个插件都要切；IUI 侧还要重建 fork，
步骤见独立仓库的 `docs/MIGRATION.md`。

1. 备份 profile：`cp -a ~/.dsh/profiles/<profile> ~/.dsh/profiles/<profile>.bak`
2. 改该 profile `package.json` 的依赖声明：
   `"miopiik-dsh": "link:/path/to/miopiik-agent"`。
3. 同步 `pnpm-lock.yaml`（或在该 profile 目录执行 `pnpm install`）。**只改软链不改锁文件，
   下次安装会把链接改回旧路径**。
4. 重建软链，或执行 `dsh plugin --profile <profile> add /path/to/miopiik-agent`。
5. 确认该 profile 没有运行中的任务后重启 DSH，验证插件页、设置页与历史会话。
6. 回滚：把软链与 `link:` 指回旧 monorepo 路径并重启；旧仓库不要删。

## 回滚

旧 monorepo 原样保留，未做破坏性改动。需要回滚时，把 profile 的 `link:` 与软链指回旧路径并重启即可。
本仓库的 `origin` 已指向 GitHub（<https://github.com/Chillizu/miopiik>），`main` 已推送，
`miopiik-agent-v0.1.1` Release 与旧资产继续有效；代码回滚可用旧 monorepo 的历史提交或旧 Release tarball。
