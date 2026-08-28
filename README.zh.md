# dsh-llm-github-copilot

[English](README.md) | 中文

GitHub Copilot LLM 适配器，适用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

使用 GitHub 账号登录后，可直接在 DeepSeek Harness 中调用所有 Copilot 模型，包括 GPT-4.1、Claude Sonnet、Gemini 和 GPT-5 系列。支持视觉能力的模型可以接受对话框中粘贴/拖拽的图片、`/goal` 和 `/plan` 携带的图片，以及 `read_image`、MCP 等工具返回的图片。

## 依赖要求

- **DeepSeek Harness `0.1.1-rc.2` 或 `0.1.2-alpha.1`。** 两个版本均受支持：适配器
  会探测实际加载的 `@deepseek-ai/dsh-llm` 并选择对应的调用约定。注意
  `0.1.2-alpha.1` 将 `CallId` 更名为 `ToolCallId`、修改了
  `requestImageHandleText` 的签名，并要求调用方自行提供请求图片的 offload
  占位符——因此**插件 `0.4.2` 及更早版本无法在 `0.1.2-alpha.1` 上加载**，请与
  harness 一同升级本插件。
- 视觉链路依赖 `0.1.1-rc.2` 新增的原生图片 API（`AttachmentStore.readImageRequest`、
  `offloadRequestImagesWithPolicy`、`requestImageHandleText`）；`0.1.0-rc.x`
  及更早版本缺少这些 API，无法运行本适配器。升级命令：
  `npm install -g @deepseek-ai/dsh@latest`。
- Node.js ≥ 24。

## 安装

### 从 npm 安装（推荐）

```sh
dsh plugin --profile web add @lujianjun19/dsh-llm-github-copilot
```

### 从 GitHub 安装

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
      name: '@lujianjun19/dsh-llm-github-copilot'
```

重启 DSH 使插件生效：

```sh
dsh web
```

## 更新

DSH profile 内部使用 pnpm 管理依赖，其 lockfile 会锁定已安装的精确版本。单独重新运行 `dsh plugin add` 不一定能升级到最新版本。请使用以下任一命令（在任意目录执行均可）：

```sh
# 使用 npm（最简单，无需额外参数）
npm install --prefix ~/.dsh/profiles/web @lujianjun19/dsh-llm-github-copilot@latest

# 使用 pnpm
pnpm add --dir ~/.dsh/profiles/web @lujianjun19/dsh-llm-github-copilot@latest --no-frozen-lockfile
```

然后重启 DSH：

```sh
dsh web
```

如需确认当前安装版本，在浏览器中打开 **设置 → GitHub Copilot**，版本号显示在页面底部。

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

**支持的 token 类型：**

| 前缀 | 来源 |
|------|------|
| `gho_` | OAuth token（`gh auth login` 默认产出） |
| `github_pat_` | fine-grained PAT（需勾选 **Copilot** 权限） |
| `ghu_` | GitHub App user token（VS Code 客户端产出） |

`ghp_` 经典 PAT 不被 Copilot API 接受。

## 功能

**动态模型发现** — 每次登录后从 `https://api.githubcopilot.com/models` 实时拉取可用模型并缓存 5 分钟，无需维护静态列表。

**视觉支持** — 声明了 `supports.vision: true` 的模型（如 `gpt-4.1`、`gpt-4o`）支持 Harness 产生的所有图片来源：对话框粘贴/拖拽、`/goal` 和 `/plan` 附件、以及工具结果图片（`read_image`、MCP）。图片按模型路由通过 Harness 附件服务（`readImageRequest`）派生，附带稳定句柄，并在两种 wire 协议上发送。当请求超过模型图片数量或本地 Base64 预算时，会优先淘汰较旧的请求图片，同时保护当前用户提交和最新工具结果批次；被省略的图片以稳定占位符标记，不修改持久历史。设置 `imageOverflowPolicy: error` 可改为超限时直接拒绝。

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
    imageOverflowPolicy: offload-oldest         # offload-oldest | error
    defaultImagePixelBudget: 4194304            # 请求图片像素预算（2048×2048）
    maxInlineRequestImageBytes: 20971520        # 所有请求图片的 Base64 总预算（20 MiB）
    inlineImageOffloadByteQuantum: 10485760     # 旧图淘汰步长（10 MiB）
    models: []   # 可选的静态 fallback 模型列表，留空则使用动态发现
```

静态 fallback 模型可以显式声明视觉能力（仅在动态 `/models` 发现失败时使用）；能力绝不根据模型名称推断：

```yaml
    models:
      - id: custom-vision-model
        inputModalities: [text, image]
        vision:
          maxImageBytes: 3145728
          maxImages: 1
          mediaTypes: [image/jpeg, image/png, image/webp]
          imagePixelBudget: 4194304
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
      ~/.dsh/profiles/web/node_modules/@lujianjun19/dsh-llm-github-copilot
dsh web
```

## 常见问题

**重启后模型选择器中看不到 "GitHub Copilot"**
几乎都是因为当前进程没有加载新插件。**重启 `dsh web`** 即可（token 已存好，无需重新登录）。

**能看到 Copilot 模型，但没有 Claude（或模型明显偏少）**
出口 IP 被限制。GitHub 只对认可的出口返回完整目录（含 Claude）。插件自动读取 shell 中的 `HTTPS_PROXY` 等代理配置，设置好代理后重启 `dsh web` 即可。

**`/copilot-login` 报网络错误或一直等待**
设备码轮询偶发网络抖动；重新运行一次 `/copilot-login` 拿新口令即可（旧口令随之失效）。

**启动时报 `configurable provider "github-copilot" is already declared`**
旧版使用了路由名 `github-copilot`（与 DSH 内置冲突）。本版已改为 `github-copilot-official`；确认 `cordis.patch.yml` 里的 `id`/`name` 与本文档一致。

**token 过期了怎么办**
不用管。底层保存的是长期有效的 GitHub OAuth token；短时效 Copilot token 由插件自动缓存并在过期前刷新。只有主动登出或吊销后才需要重新 `/copilot-login`。

## 许可证

[MIT](LICENSE)
