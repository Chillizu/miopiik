# 支持矩阵

本仓库仅发布 MiOpIIk Agent（`miopiik-dsh`）。MiOpIIk IUI（`miopiik-iui`）位于独立仓库并维护各自的支持矩阵。

| 项 | miopiik-dsh (Agent) |
|---|---|
| 包类型 | 独立可安装的 DSH 插件包（host 侧 + web 客户端） |
| 当前版本 | 0.1.2（stable） |
| 依赖另一个包 | 否：不依赖 `miopiik-iui`，可单装或与 IUI 同装 |
| Tarball 安装 | 支持（`files` 含 `host/` 等全部运行时文件） |
| 运行中 profile 安装 | 安装后需重启该 profile 的 DSH 进程生效 |
| 安装命令 | `dsh plugin --profile <name> add <tarball 或本地路径>`（未发布到 npm registry；也可使用 `tools/install-plugin.mjs`） |
| DSH 测试基线 | 0.2.1-rc.5 |
| Node | >= 23.6 |
| 平台 | web（DSH Web GUI）；仅 web profile |
| 宿主补丁依赖 | 无宿主补丁依赖，标准安装即可用 |
| 数据写入 | 仅写入工作区下 `.dsh/miopiik/` 的 append-only JSONL 账本，不修改宿主配置 |

## 已知限制

- 安装、升级或卸载插件后，需重启对应 profile 的 DSH 进程；安装脚本不自动重启服务。
- 插件设置页（DSH「设置 → 内置插件 → MiOpIIk Agent」）只读展示 Host 参数的内置默认值；实际生效值以 profile 的 `cordis.patch.yml` 中 `miopiik-dsh` 的 `config` 段为准。
- `tools/install-plugin.mjs --execute` 默认拒绝写入正在运行的 `web` profile，需显式传入 `--allow-running-profile` 并在重启后生效。
