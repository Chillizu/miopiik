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

## 回滚

拆分施工期间旧 monorepo 原样保留，未做破坏性改动；
需要回滚时直接回到旧 monorepo 即可。本仓库的 `origin` 在施工阶段仍指向旧 monorepo 的本地路径，
最终发布前由维护者改为 GitHub 远程。
