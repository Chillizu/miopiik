# miopiik-dsh · MiOpIIk Agent for DeepSeek Harness

Mind / Ink / Operator —— 把"对话"和"后台行动"表示为同一条日志上的两条时间线。
这是一个 **独立的 DSH 插件包**，不依赖 `miopiik-iui`。

## 安装

```bash
# 1) 本地链接安装（开发/自托管推荐）
dsh plugin --profile <profile> add /absolute/path/to/miopiik-dsh

# 2) 从打包产物安装
npm pack                       # 生成 miopiik-dsh-<version>.tgz
dsh plugin --profile <profile> add ./miopiik-dsh-<version>.tgz
```

安装后重启对应 profile 的 DSH 进程生效（宿主插件在启动时加载）。卸载：从 profile 的
`package.json` 依赖移除并执行 `dsh plugin --profile <profile> remove miopiik-dsh`，重启即可；
未写入的会话数据不会因为卸载而删除。

## 能力边界

- 提供 Mind/Ink/Operator 的 Host 侧工具与提示词（`ink_*`），以及对话内的可视化节点。
- 不包含 IUI 渲染层；需要声明式界面时另装 `miopiik-iui`。
- 展示协议保持向后兼容：历史会话中的旧 `ink_view` 数据仍可回放。

## 兼容性

见仓库根目录 `docs/SUPPORT-MATRIX.md`。测试基线：DSH 0.2.1-rc.5、Node ≥ 23.6。

## 许可

MIT
