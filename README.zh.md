# dsh-llm-github-copilot

[English](README.md) | 中文

GitHub Copilot LLM 适配器，适用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

使用 GitHub 账号登录后，可直接在 DeepSeek Harness 中调用所有 Copilot 模型，包括 GPT-4.1、Claude Sonnet、Gemini 和 GPT-5 系列。支持视觉能力的模型还可以在对话框中粘贴或拖拽图片。

## 从 GitHub 安装

```sh
dsh plugin --profile web add github:lujianjun19/dsh-llm-github-copilot
```

pnpm 10 及以上版本默认禁止 Git 依赖运行构建脚本。如果安装过程中提示需要批准构建，请将提示的包名加入该 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-llm-github-copilot: true
```

然后重新执行安装命令。

安装完成后，在 profile 的 `cordis.patch.yml` 中注册插件：

```yaml
- insert:
    - id: llm-github-copilot
      name: '@deepseek-ai/dsh-llm-github-copilot'
```

重启 DSH 使插件生效：

```sh
dsh web
```

## 登录

在 Harness 对话框中运行登录命令：

```
/copilot-login
```

按照提示操作：在浏览器中打开验证链接，输入显示的设备码，并授权 GitHub App。授权完成后 token 会自动存储。运行 `/copilot-status` 可确认连接状态并查看可用模型列表。

退出登录：

```
/copilot-logout
```

也可以直接通过环境变量设置 token（适用于 CI 或无界面场景）：

```sh
export GITHUB_COPILOT_OAUTH_TOKEN=<your-github-oauth-token>
```

## 功能

**动态模型发现** — 每次登录后从 `https://api.githubcopilot.com/models` 实时拉取可用模型并缓存 5 分钟，无需维护静态列表。

**视觉支持** — 声明了 `supports.vision: true` 的模型（如 `gpt-4.1`、`gpt-4o`）支持图片输入。将 PNG/JPEG/WebP/GIF 粘贴或拖拽到对话框，图片会自动附加、持久化，刷新后历史记录中仍可查看。

**双协议** — 适配器同时支持 OpenAI Chat Completions（`/chat/completions`）和新版 Responses API（`/responses`），根据模型自动选择对应端点。

**推理控制** — 支持声明了推理等级的模型（`gpt-5.x`、Claude 思考预算、Gemini 推理），可传递 `low / medium / high / max` 等级。

**自动刷新 token** — 短期有效的 Copilot API token 在过期前自动续期，无需手动操作。

**设置页面** — 插件在 Harness Web 设置界面新增 **GitHub Copilot** 专属页面（在浏览器中打开 DSH → 点击齿轮图标 → **GitHub Copilot**）。在该页面可以登录、查看认证状态和可用模型列表、退出登录，无需在对话框输入命令。

## 配置

插件无需任何配置即可使用。如需覆盖默认值，请编辑 profile 的 `cordis.patch.yml`：

```yaml
- id: llm-github-copilot
  config:
    oauthTokenEnv: GITHUB_COPILOT_OAUTH_TOKEN   # 存储 GitHub OAuth token 的环境变量名
    baseURL: https://api.githubcopilot.com       # 覆盖 Copilot API 地址
    defaultContextWindow: 262144
    defaultMaxTokens: 32768
    streamIdleTimeoutMs: 300000
    models: []   # 可选的静态 fallback 模型列表，留空则使用动态发现
```

## 开发

需要 Node.js ≥ 24 和 npm。

```sh
cd /path/to/dsh-llm-github-copilot
npm run build      # 合并源码分片 → lib/index.js 和 lib/client.js
npm test           # 构建 + 确定性产物、i18n、元数据测试
npm run check      # 构建 + 测试 + npm pack 演练
npm run deploy     # 测试 → 构建 → 原子部署，保留回滚备份
```

直接将当前 checkout 安装到本地 profile：

```sh
dsh plugin --profile web add .
```

修改 Host 代码后需重启 DSH；仅修改 Client 代码时，硬刷新（`Ctrl+Shift+R`）通常就足够了。

## 回滚

`npm run deploy` 在每次安装前会保留带时间戳的备份。如需回滚，停止 DSH 后还原对应备份：

```sh
cp -r ~/.dsh/plugin-backups/dsh-llm-github-copilot/<时间戳> \
      ~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-llm-github-copilot
dsh web
```

## 许可证

[MIT](LICENSE)
