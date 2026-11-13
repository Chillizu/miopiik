# 支持矩阵

本仓库只发布 MiOpIIk Agent（`miopiik-dsh`）一个包。IUI（`miopiik-iui`）是独立仓库的另一个包，
有自己的支持矩阵，不在此列。

| 项 | miopiik-dsh (Agent) |
|---|---|
| 包类型 | 独立可安装的 DSH 插件包（host 侧 + web 客户端） |
| 当前版本 | 0.1.1（stable，可发布） |
| 依赖另一个包 | 否：不依赖 `miopiik-iui`，可与 IUI 同装或单装 |
| Tarball 安装 | 支持（`files` 已含 `host/` 等全部运行时文件） |
| 运行中 profile 安装 | 需重启该 profile 的 DSH 进程后生效 |
| 安装命令 | `dsh plugin --profile <name> add <tarball 或本地路径>`（未发布 npm registry，裸包名不可解析；也可用本仓库 `tools/install-plugin.mjs`） |
| DSH 测试基线 | 0.2.1-rc.5 |
| Node | ≥ 23.6 |
| 平台 | web（DSH Web GUI）；仅 web profile |
| 宿主补丁依赖 | 无宿主补丁依赖，标准安装即可用 |
| 数据写入 | 只写 workspace 下 `.dsh/miopiik/` 的 append-only JSONL 账本，不写宿主配置 |

## 已知限制

- 安装或升级插件后必须重启对应 profile 的 DSH 进程，插件才会加载；安装脚本本身不会重启服务。
- 插件设置页（DSH「插件 → 已安装 → MiOpIIk」）只读展示 Host 参数的内置默认值；
  实际配置以 profile 的 `cordis.patch.yml` 中该插件的 `config` 段为准，不支持在设置页直接改。
- `install-plugin.mjs --execute` 默认拒绝写入正在使用的 `web` profile，
  必须显式加 `--allow-running-profile` 并自行备份、随后重启生效。
