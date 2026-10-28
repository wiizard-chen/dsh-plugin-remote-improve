# DSH Remote Improve

用于备份和共享本地 DSH 通用插件。今后的插件开发以本仓库为准，不直接修改 DSH 的全局安装目录。

## 已收录

| 插件 | 用途 |
| --- | --- |
| [dsh-copy-file-link](packages/dsh-copy-file-link/README.md) | 在 Web 文件预览工具栏复制文件的绝对路径；不是公网分享链接 |
| [@local/dsh-perf-patches](packages/dsh-perf-patches/README.md) | WebSocket 压缩与会话首屏记录预算 |
| [@local/dsh-perf-context-floor](packages/dsh-perf-context-floor/README.md) | 配合首屏预算，尽可能补齐最近对话轮次 |

后两个是依赖 DSH 内部实现的**实验性宿主补丁**，不是官方稳定 API。迁移基线为 Node.js 24、DSH `0.2.1-rc.2`；升级 DSH 后请重新验证。此次迁移保留插件运行逻辑，不借迁移顺便改变行为。限制见各插件说明。

## 可选第三方：自动归档

已接入 [dsh-session-auto-archive](https://github.com/xiao-hans/dsh-session-auto-archive)，可在设置界面配置“最后活动后闲置 N 天自动归档”，不是删除对话。第三方源码外置；本仓库固定上游版本，并维护远程部署路径、原生登录鉴权与停用清理的兼容补丁。

```bash
npm run setup:auto-archive             # 仅预览
npm run setup:auto-archive -- --apply  # 安装；首次保持演练，不立即归档
```

完整的设置位置、预览到正式启用流程、来源和限制见 [自动归档说明](docs/AUTO-ARCHIVE.md)。默认通用插件安装不包含此可选项。

## 给朋友安装

先安装并运行一次 DSH Web，确保目标 profile 已创建，然后：

```bash
git clone https://github.com/wiizard-chen/dsh-plugin-remote-improve.git
cd dsh-plugin-remote-improve
npm run verify

# 默认仅预览，不写入配置
node scripts/install.mjs

# 默认仅安装文件路径复制插件
node scripts/install.mjs --apply

# 可选：同时安装两个实验性性能插件（先预览）
node scripts/install.mjs --with-perf
node scripts/install.mjs --with-perf --apply
```

本仓库的三个本地插件没有 npm 依赖，不需要 `npm install`，也不修改全局 DSH 的文件；可选第三方自动归档会在仓库外单独安装锁定的运行依赖。脚本使用当前 checkout 的实际路径，**安装后不要随意移动或删除仓库**。同一个 checkout 可供多个 profile 链接。

自定义 DSH 目录或 profile：

```bash
node scripts/install.mjs --home /absolute/path/to/dsh-home --profile web
node scripts/install.mjs --home /absolute/path/to/dsh-home --profile web --apply
```

安装器只更新目标 profile 的依赖、bundle 顺序和选中插件的软链接，保留其他插件与配置。变更前在 profile 下备份；存在非软链接目录或未知来源链接时拒绝覆盖。不要把真实 profile、备份或账号设置放进本仓库。

三个本地插件的安装脚本不调用包管理器。若目标 profile 已有 pnpm 锁文件，后续使用冻结锁安装前，需在**该 profile 目录**按其原有包管理方式同步锁文件；已缓存依赖的环境可执行 `pnpm install --lockfile-only --offline --ignore-scripts`。锁文件及其备份仍留在本机，不要复制进共享仓库。

宿主模块通常需要重新加载后生效；前端插件不是本仓库自动热更新。请在没有进行中的任务时，**自行按原来的启动方式重启 DSH Web，然后刷新浏览器**。安装脚本不会自动重启服务，以免中断任务。

卸载（先预览，再执行）：

```bash
node scripts/install.mjs --remove
node scripts/install.mjs --remove --apply
```

卸载只处理本仓库的三个包，不触碰其他插件。安装前备份可用于手工恢复原有链接和 manifest。

## 开发与验证

- 源码在 [packages](packages)，安装入口在 [安装脚本](scripts/install.mjs)。
- `npm run verify` 检查源码语法、包结构、仓库边界，并运行 Node.js 测试；无需浏览器或线上服务。
- 单元测试使用伪造的宿主模块，证明插件挂接与安装逻辑，不等于任意 DSH 版本的端到端兼容保证。
- 前端改动需在真实 DSH Web 中刷新后复测文件预览、按钮与剪贴板权限；宿主补丁需检查日志、会话打开和“加载更早”。
- 更改后先检查 `git diff`，再提交并通过 SSH 推送到自己的远端。

## 范围与隐私

只收录通用插件源代码、合成测试和通用说明。**不收录持仓讨论插件及任何业务数据**；也不包含会话记录、附件、日志、真实 profile、账号凭据、API Key、MCP token、截图或本机历史调查材料。

`dsh-web-mobile` 是独立第三方插件，保持外部依赖。本机安装包已与 npm `3.0.6` 发布包逐文件比对一致，没有待备份的本地源码差异。本仓库不复制它的代码，也不自动安装它。

早期重连修复属于直接修改 DSH 安装产物的历史实验，不是当前启用的独立插件；不将实验日志或旧版 patch 当成现行插件发布。

更多维护约定见 [AGENTS.md](AGENTS.md)，迁移记录见 [迁移说明](docs/MIGRATION.md)。
