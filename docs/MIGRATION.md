# 迁移说明：monorepo → MiOpIIk Agent 独立仓库

本仓库由 MiOpIIk monorepo 拆分而来，将原有的两个独立 DSH 插件包（`miopiik-dsh` 与 `miopiik-iui`）拆分为两个可独立 clone、构建、`npm test`、`npm pack` 与安装的仓库。本文件记录 MiOpIIk Agent（包名 `miopiik-dsh`）的迁移来源、目录布局变化与兼容性说明。

## 来源

| 项 | 值 |
|---|---|
| 来源仓库 | [https://github.com/Chillizu/miopiik](https://github.com/Chillizu/miopiik) |
| 公开 main 提交 | `adb12bc` |
| 拆分前本地工作 tip | `332fd84`（IUI 围栏容错修复，尚未 push） |
| 本仓库历史 | 从 monorepo 直接延续：240 个提交、6 个旧 tag 全部保留，历史未重写 |

保留的旧 tag：`v0.1.0`、`v0.1.1`、`v0.1.2`、`v0.1.3`（早期文档里程碑）、`miopiik-agent-v0.1.1`；`miopiik-iui-v0.1.0-rc.4` 为 monorepo 时期给 IUI 打的 tag，随历史保留，不作为本仓库的发布 tag。

## 布局变化（Agent）

拆分前 Agent 包位于 `miopiik-dsh/` 子目录；拆分后内容整体上移至仓库根目录，**仓库根即包根**（`package.json` 与 `index.js` 同级）。

| 拆分前（monorepo） | 拆分后（本仓库） |
|---|---|
| `miopiik-dsh/package.json` | `package.json` |
| `miopiik-dsh/index.js`、`client.js`、`icon.svg`、`cordis.patch.yml` | 仓库根同名文件 |
| `miopiik-dsh/host/`、`miopiik-dsh/locale/` | `host/`、`locale/` |
| `miopiik-dsh/test/` | `test/` |
| `miopiik-dsh/tools/` | `tools/` |
| `miopiik-dsh/docs/` | `docs/`（`SPEC.md` 在仓库根） |
| `miopiik-iui/**` | 迁出至独立仓库 |
| monorepo 根级 CI / 发布脚本 | 按单包结构放在本仓库根（`.github/`、`tools/`） |

包名 `miopiik-dsh` 与安装命令保持不变；版本在拆分后按 patch 递增，当前稳定版为 `0.1.2`，tag `miopiik-agent-v0.1.2`。旧版 `miopiik-agent-v0.1.1` Release 及其资产（`miopiik-dsh-0.1.1.tgz`、`SHA256SUMS.txt`）保持有效，仓库地址仍为 `https://github.com/Chillizu/miopiik`。

## 另一个仓库（MiOpIIk IUI）的迁移方式

IUI 使用 `git subtree split -P miopiik-iui` 从 monorepo 提取，保留 13 个 IUI 相关提交的历史（subtree split 会重写提交哈希，原始哈希见来源仓库），随后在仓库根补齐测试、工具、文档与 CI。旧仓库的同名 Release（`miopiik-iui-v0.1.0-rc.4`）资产与下载链接保持有效；新仓库独立发布 `v0.1.0-rc.4` prerelease。

## 历史数据兼容

- 旧的 `ink-view` JSONL 与会话内容零迁移、不删除；渲染层由 IUI 的只读 legacy adapter 将历史七 Widget spec 映射为 `iui/1` AST 回放。
- Agent 账本路径不变，仍为工作区下 `.dsh/miopiik/` 的 append-only JSONL，已有环境无需移动数据。

## 自托管：把已有 profile 从 monorepo 布局切到本仓库

若此前通过 `link:` 将 monorepo 子目录接入 DSH profile，拆分后需将 profile 指向切至独立仓库（IUI 侧步骤见 IUI 仓库的 `docs/MIGRATION.md`）：

1. 备份 profile：`cp -a ~/.dsh/profiles/<profile> ~/.dsh/profiles/<profile>.bak`
2. 修改该 profile `package.json` 的依赖声明：`"miopiik-dsh": "link:/path/to/miopiik-agent"`。
3. 同步更新 `pnpm-lock.yaml`（或在该 profile 目录执行 `pnpm install`），使锁文件与软链一致。
4. 重建软链，或执行 `dsh plugin --profile <profile> add /path/to/miopiik-agent`。
5. 确认该 profile 无运行中任务后重启 DSH，验证插件页、设置页与历史会话。
6. 如需回滚，将软链与 `link:` 指回原 monorepo 路径并重启 DSH。

## 回滚

原 monorepo 备份保持完整。回滚时可将 profile 的 `link:` 与软链指回原路径并重启，也可使用 `miopiik-agent-v0.1.1` Release 的 `miopiik-dsh-0.1.1.tgz` 重新安装。
