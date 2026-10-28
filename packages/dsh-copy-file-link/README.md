# dsh-copy-file-link

在 DSH Web 右侧文件预览工具栏添加一个图标按钮，点击后复制宿主报告的**文件绝对路径**，不是 Markdown 链接或可公开访问的 URL。

- 中英文提示、成功/失败状态。
- 优先使用 Clipboard API，失败时回退到旧的复制命令；浏览器权限仍可能导致失败。
- 不读取文件内容、不向外发送数据、不上传文件。
- 浏览器 bundle 已是普通 JS，无编译步骤；使用 DSH 提供的 React、slots 和 locale。

在仓库根目录运行安装脚本，默认仅安装此插件；先 dry-run，再 `--apply`。详见 [根目录说明](../../README.md)。

```bash
node scripts/install.mjs
node scripts/install.mjs --apply
node --test packages/dsh-copy-file-link/test/*.test.mjs
```

前端使用的 slot 是 `sidebar.right.tab.document.actions`，由 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` 提供；DSH 改动该接口后需要适配。安装后在安全时机重新加载 Web 服务并刷新页面，打开文件预览后验证按钮和复制结果。
