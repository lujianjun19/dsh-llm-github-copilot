# dsh-llm-github-copilot

[English](README.md) | 中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供 GitHub Copilot 登录。

使用 GitHub 账号登录后，即可在 DeepSeek Harness 中使用你的订阅所包含的全部 Copilot 模型——GPT-5 系列、Claude、Gemini 等。

Harness 本身已经内置了一个 `github-copilot` 提供方，可以服务这些模型；它唯一做不到的是让你登录。本插件正是填补这个缺口：运行 GitHub 设备流，并发布该提供方用于认证的凭据。请求、模型发现、图片与流式处理全部由 Harness 的路由负责，不在本插件内。参见 [`docs/adr/0002-narrow-to-credential-provider.md`](docs/adr/0002-narrow-to-credential-provider.md)。

## 依赖要求

- **DeepSeek Harness `0.1.2-alpha.1` 或更高版本**，且启用其自带的
  `@deepseek-ai/dsh-llm-pi-ai` 路由（默认已挂载）。本插件写入的正是该路由读取的凭据。
- 一个拥有 Copilot 订阅的 GitHub 账号。
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

**设备流登录** — 无需自行创建或粘贴 token。执行 `/copilot-login` 或使用设置页，在浏览器完成授权后凭据会自动保存。

**自动刷新（由下游完成）** — 凭据中保存的是长期 GitHub token。Harness 路由会自行交换出短期 Copilot token、自动续期，并推导出你账户对应的 API 端点（个人 / 企业 / Enterprise）。

**沿用已有 token** — 如果环境中已导出 `GITHUB_COPILOT_OAUTH_TOKEN`，或旧版本插件已保存过该凭据，启动时会自动沿用，无需二次登录。

**设置页面** — Harness Web 设置界面中的 **GitHub Copilot** 专属页面（齿轮图标 → **GitHub Copilot**），可登录、查看状态、退出登录。模型在 **设置 → 模型** 中的 `github-copilot` 提供方下选择。

**斜杠命令** — `/copilot-login`、`/copilot-status`、`/copilot-logout`，供没有设置界面的场景使用。

## 选择模型

登录只发布凭据，不会替你选模型。登录后请打开 **设置 → 模型**，添加 **`github-copilot`** 提供方，并在其中选择模型。

## 从 0.4.x 升级

0.4.5 及更早版本会注册自己的 `github-copilot-official` 提供方，该提供方已不再存在。如果你的设置或历史会话引用了它，请改为 `github-copilot` 提供方——模型 id 完全相同。已保存的凭据会被自动沿用，无需重新登录。

## 配置

本插件开箱即用。唯一的设置项是保存 GitHub OAuth token 的凭据引用：

```yaml
- id: llm-github-copilot
  config:
    oauthTokenEnv: GITHUB_COPILOT_OAUTH_TOKEN   # 凭据引用 / 环境变量名
```

与模型、端点、请求行为相关的配置全部位于 Harness 路由的 `llm-pi-ai` 设置段，不在这里。

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
本插件不再注册自己的提供方——它只为 Harness 内置的 `github-copilot` 提供方发布凭据。如果看不到模型，请确认已登录（`/copilot-status`），并已在 **设置 → 模型** 中添加 `github-copilot` 提供方。同时确认 `cordis.patch.yml` 里的 `id`/`name` 与本文档一致。

**token 过期了怎么办**
不用管。底层保存的是长期有效的 GitHub OAuth token；短时效 Copilot token 由插件自动缓存并在过期前刷新。只有主动登出或吊销后才需要重新 `/copilot-login`。

## 许可证

[MIT](LICENSE)
