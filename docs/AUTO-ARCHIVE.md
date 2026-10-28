# 自动归档：第三方插件接入

采用 [xiao-hans/dsh-session-auto-archive](https://github.com/xiao-hans/dsh-session-auto-archive)，保留上游作者与 MIT 许可证，不另写一套归档引擎，也不把它冒充成本仓库原创插件。相关版权声明见 [第三方声明](../integrations/auto-archive/NOTICE.md)。

## 功能与当前策略

- 按**最后活动后闲置 N 天**归档，不是按会话创建日期。N 可在设置界面调整，支持至少 0.5 天。
- 归档使用 DSH 原生归档状态，不删除会话、附件或日志；可取消归档。
- 默认跳过内存中的会话、活跃任务、置顶会话及子代理会话；也可按工作区路径子串排除。
- 初次接入为**演练模式**：默认 14 天、每 12 小时扫描，启动约 1 分钟后首轮。演练只记录计划，不真正归档，但会写本机审计日志。

用户正式启用前，应先检查预览结果。安装命令不会重启 DSH，也不主动扫描真实会话；插件被运行时加载后，会按上述定时器执行演练。

## 为什么不是直接安装未经修改的上游

固定来源为上游 `v0.1.1`，commit `29854414f538842387f5fbc74ee6c822da92d48b`。上游接口形状与 DSH `0.2.1-rc.2` 匹配，但原版存在当前接入所需的兼容和安全问题：

1. 浏览器 API 写死根路径，不适配 `/dsh/` 等前缀部署。
2. 自定义 HTTP 路由只做 loopback 判断，不能当作 DSH 登录鉴权，反向代理尤其不能靠放宽来源规则解决。
3. 扫描中卸载会继续处理并可能重建定时器。
4. 手动运行接口带调试覆写，可临时越过演练、停用和 live 检查。

因此本仓库维护一层[明确的兼容补丁](../integrations/auto-archive/patch.mjs)：

- API 相对页面部署根解析，不修改全局网关或代理配置。
- 每个路由先经过原生 Connection 的登录、Host/Origin 校验，并仅允许 owner；依赖不可用或校验异常时拒绝访问。
- 停用清理定时器，在途扫描后不重建；每轮及归档前检查停用状态。**已经进入原生归档调用的那一个 Promise 可能完成**，不声称能回滚正在提交的操作。
- 手动运行只允许加强演练保护，不接受调试绕过；坏 JSON 返回 400。正式运行必须先在设置里保存关闭演练。

生成包显示版本为 `0.1.1-remote.1`，与未经修改的上游版本区分。归档判定算法和原设置卡片仍来自上游。

## 安装

需要已有 DSH Web profile、Node.js 24、Git 和 npm。先在仓库根目录：

```bash
npm run verify

# 只预览：不联网、不改配置、不扫描、不重启
npm run setup:auto-archive

# 明确执行：下载固定 commit、校验文件、生成派生包并注册到 Web profile
npm run setup:auto-archive -- --apply
```

其他 profile 或 DSH home：

```bash
npm run setup:auto-archive -- --home /absolute/path/to/dsh-home --profile web
npm run setup:auto-archive -- --home /absolute/path/to/dsh-home --profile web --apply
```

已经有固定版本的本地上游 checkout，可传 `--source /absolute/path/to/upstream-checkout`。所有白名单文件都必须与记录的 SHA-256 一致；即使 Git HEAD 不变，源码有改动也会被拒绝。

安装入口是 [setup-auto-archive.mjs](../scripts/setup-auto-archive.mjs)，与[三个本地插件的安装器](../scripts/install.mjs)分开。默认通用安装不自动启用第三方插件。

### 文件与依赖在哪里

- 上游源和派生包放在用户选择的 DSH home 下 `third-party/`，不复制进本仓库。
- 仓库只保存[来源与校验和](../integrations/auto-archive/upstream.json)、兼容补丁和[上游运行依赖锁](../integrations/auto-archive/package-lock.json)。该锁是公开依赖锁，**不是用户 profile 锁**。
- 运行依赖用 `npm ci --omit=dev --ignore-scripts` 安装到派生包目录；不运行上游或依赖的生命周期脚本。
- 新建的私有配置位于 DSH home 的 `storages/auto-archive/config.json`，初次明确写入 `dryRun: true`。若发现旧配置已经为真实归档模式，安装器拒绝无人值守接入，不静默覆盖。
- profile 的依赖、bundle 和软链接变更前会备份，其他插件及其配置不变。
- 若 profile 已有 pnpm 锁文件，可在 **profile 目录**按原管理方式同步，例如 `pnpm install --lockfile-only --offline --ignore-scripts`。这不会替代派生包内部的 npm 依赖安装。

派生目录视为不可变构建：已有内容或依赖与记录不同则拒绝覆盖，不在正在运行的包下面偷偷更新。要升级上游或修改兼容补丁，应更新来源/hash、审查差异、提升派生版本后重装，而不是直接 `git pull`。

## 在哪里设置天数

先刷新浏览器，查看插件是否已被当前 DSH 运行时加载。若设置卡片仍未出现或提示接口未注册，再等任务结束后按原来的方式重启 DSH Web 并刷新。不要把 profile 重载等同于以后源码修改的自动热更新。

1. 打开 **设置 → 插件设置 → 会话自动归档**，展开卡片；也可从已安装插件的“配置”进入。
2. 修改 **闲置天数阈值**，例如 `7`、`14` 或 `30`，点击保存。
3. 保持 **演练模式** 开启，点击 **立即扫描一次**，检查“归档历史”里的演练计划。
4. 确认范围符合预期后，关闭 **演练模式** 并保存；总开关保持开启，此后定时自动归档。
5. 停用自动归档：关闭总开关并保存。取消归档可使用插件历史中的撤销或 DSH 原生归档列表。

演练状态下，接口不能通过一次性 `dryRun:false` 绕过设置直接归档。所有操作仍要求已登录的 owner 会话；不需要复制令牌到仓库或修改代理放行规则。

## 验证、限制与卸载

- `npm run verify` 是纯合成单元测试，不依赖真实 profile 或上游下载。
- 派生包构建时检查源码 SHA、严格补丁匹配次数、锁定依赖版本与 JS 语法；注册前还使用完整派生包及真实运行依赖，在临时 DSH home 中测试 owner-only 路由、演练保护、阈值修改、合成会话归档与撤销，不接触真实会话。真实 DSH 上仍需登录后验证设置卡片和预览结果。
- 时间判定沿用上游的用户活动戳与日志 revision 兜底，并非任意 DSH 版本的稳定契约。升级 DSH 后重新验证。
- 置顶/live 的判断是扫描时的保护，不声称消除了所有并发竞态。DSH 原生归档还会检查活跃任务，插件不传 `stopActivity:true`。
- “撤销上次批量”状态在内存中，重启后不保证保留；逐条归档状态仍可通过原生列表恢复。
- 审计历史包含本机会话标识、标题和工作区路径，只留本机；严禁提交这些文件。

```bash
# 只预览卸载
npm run setup:auto-archive -- --remove
# 解除本仓库管理的归档 bundle，不删除聊天或历史
npm run setup:auto-archive -- --remove --apply
```

卸载也需要安全重新加载后生效，保留私有配置、历史和第三方源码以便恢复。三个本地通用插件不受此操作影响。
