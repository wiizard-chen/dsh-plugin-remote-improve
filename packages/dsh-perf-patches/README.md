# @local/dsh-perf-patches（实验性）

不修改 DSH 安装文件，通过 profile bundle 加载时的运行时挂接改善远程 Web 会话加载：

1. 在 WebSocket upgrade 时启用 `perMessageDeflate`，压缩较大的消息。
2. 限制首次 snapshot 的记录窗口，仅保留较近的记录，并设 `hasMore=true`；历史 `page()` 不被裁剪，仍可“加载更早”。

## 安装与顺序

在仓库根目录：

```bash
node scripts/install.mjs --with-perf
node scripts/install.mjs --with-perf --apply
```

性能插件是可选项；以上同时安装文件路径复制插件和配套的上下文补全插件。顺序必须是：

```text
@local/dsh-perf-patches
@local/dsh-perf-context-floor
@deepseek-ai/dsh-base
…其他既有 bundles
```

安装不自动重启。安全时机重启后检查控制台的 `[dsh-perf-patches]` 信息，并用合成或非敏感会话验证首屏、运行中事件和历史分页。

## 配置

按原有 DSH 启动方式给进程传入环境变量；仓库不保存真实环境文件。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `DSH_PERF_PAGE_BUDGET_BYTES` | `1200000` | 首屏窗口预算（当前近似字符串长度，非严格字节） |
| `DSH_PERF_DISABLE_DEFLATE` | 未设 | `1` 禁用压缩挂接 |
| `DSH_PERF_DISABLE_BUDGET` | 未设 | `1` 禁用首屏裁剪 |
| `DSH_INSTALL_ANCHOR` | 自动定位 | 必要时指定正在运行的 DSH 安装的 package manifest 绝对路径 |

## 兼容性与限制

基线：DSH `0.2.1-rc.2`、Node.js 24。它依赖 `ws.WebSocketServer` 和 `SessionController.follow()` 内部结构，不是稳定扩展 API；升级后必须重新验证。

- 压缩挂接作用于宿主共享 prototype，会覆盖原本为 false 的压缩配置；压缩也会带来 CPU 开销。
- 预算使用 `JSON.stringify(record).length`，中文等多字节文本可能超出同数值 UTF-8 字节数。
- 单条超大记录仍然保留，不能把预算当成网络帧严格上限。
- 部分接口不匹配会记录 `SKIPPED`，但安装定位失败仍可能抛错；不是无条件 fail-open。
- 与上下文补全搭配后，最终首屏会比裁剪后的窗口更大。

迁移保持原始运行逻辑；这些边界将在后续独立改动中修正。卸载和验证方式见 [根目录说明](../../README.md)。
