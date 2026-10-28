# @local/dsh-perf-context-floor（实验性）

[首屏预算插件](../dsh-perf-patches/README.md)可能把窗口裁在一轮对话中间，导致先看到大量工具状态而看不到问题。此配套插件使用宿主 `page()` 向前补充整页记录，尽可能从 `turn/start` 开始，并带上少量较近的完整对话。

它必须在 `@local/dsh-perf-patches` **之后**、基础 bundle **之前**加载，根目录安装器会统一维护顺序。

```bash
# 在仓库根目录运行；先预览，确定后执行
node scripts/install.mjs --with-perf
node scripts/install.mjs --with-perf --apply
```

## 配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `DSH_PERF_FLOOR_SOFT_BYTES` | `1200000` | 尽量补足的窗口量（当前按 JSON 字符串长度近似） |
| `DSH_PERF_FLOOR_HARD_BYTES` | `8388608` | 下一次取页前的停止条件，不是最终严格上限 |
| `DSH_PERF_FLOOR_MAX_TURNS` | `3` | 下一次取页前判断的目标轮次数 |
| `DSH_PERF_FLOOR_DISABLE` | 未设 | `1` 跳过补全插件 |
| `DSH_INSTALL_ANCHOR` | 自动定位 | 必要时指定宿主 DSH 的 package manifest 绝对路径 |

## 兼容性与限制

- 与当前迁移基线 DSH `0.2.1-rc.2`、Node.js 24 配套。内部 `SessionController.follow/page` 变化后需重新验证。
- 按整页补入，单页可能使最终窗口超出上述 HARD 或轮次数；它们不能当成严格资源上限。
- JSON 字符串长度不等于 UTF-8 字节数，对中文会低估实际传输体积。
- 存在分页保护次数；没有历史、没有可用序号、接口报错等情形可能无法补齐完整轮次。
- 分页失败会回退到输入窗口并告警；但宿主安装定位失败仍可能抛错。
- 不改磁盘会话记录，只影响发送给客户端的窗口；仍需验证“加载更早”和活跃会话连续性。

此次迁移不改变算法。详见 [迁移说明](../../docs/MIGRATION.md)及[根目录安装说明](../../README.md)。
