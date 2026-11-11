# dsh-llm-github-copilot

[English](README.md) | 中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供 GitHub Copilot 设备流登录页面和聊天命令。本插件**只提供凭据**；模型、token 刷新、图片和请求均由 Harness 内置的 `github-copilot` 路由负责。

## 依赖要求

- Harness `0.2.2-rc.1`（当前开发基线）；[旧版支持范围及兼容性说明](docs/USER_GUIDE.zh.md#兼容性)。
- 一个有 Copilot 权限的 GitHub 账号；Node.js ≥ 24，`PATH` 中须有 pnpm ≥ 9。
- 默认 Web profile，或包含 `@deepseek-ai/dsh-llm-pi-ai` 和 `dsh-credentials-local` 的自定义组合。

## 安装与更新

从 npm 安装：

```sh
dsh plugin --profile web add @lujianjun19/dsh-llm-github-copilot -w
```

更新已有安装：

```sh
dsh plugin --profile web update @lujianjun19/dsh-llm-github-copilot --latest -w
```

重启 `dsh web` 并硬刷新浏览器，在 **设置 → GitHub Copilot** 页面底部确认版本。bundle 会自动注册，不要在 profile patch 中重复添加插件 `insert`。

[GitHub 源安装、指定版本和更新延迟](docs/USER_GUIDE.zh.md#安装与更新)见使用指南。

## 登录并使用模型

1. 打开 **设置 → GitHub Copilot → 登录**。
2. 在提示的 GitHub 链接中输入设备码，授权 GitHub App（VS Code）。插件会自动保存 token。
3. 在 **设置 → 模型** 中添加内置 **`github-copilot`** 提供方（若尚未配置），无需自定义端点或粘贴 API key。
4. 保存后，在聊天模型选择器中选择模型并发起请求。

**登录不会自动添加提供方配置。** 模型可见不代表账号有权使用；可用性取决于 Harness 目录和账号/组织策略。

也可以使用聊天命令：

| 命令 | 用途 |
| --- | --- |
| `/copilot-login` | 发起登录 |
| `/copilot-status` | 检查是否已保存 token，不代表实际请求成功 |
| `/copilot-logout` | 删除本地 grant 和可写的 token 引用 |

退出不会撤销 GitHub 授权或删除模型配置。若外部 token 仍存在，界面会提示；请从环境变量/`.env` 或外部来源移除它，重启 DSH，再退出一次。

## 可选配置

设备流登录无需配置。也可以使用已有的兼容**长期 GitHub OAuth token**：

```sh
export GITHUB_COPILOT_OAUTH_TOKEN='<your-github-oauth-token>'
dsh web
```

已有 grant 的优先级更高。不要假设任意 PAT 都有 Copilot 权限；短期 Copilot API token 不适用于此处。

插件唯一选项 `oauthTokenEnv` 用于更改凭据引用名。在活动 profile 的 `cordis.patch.yml` 中覆盖已安装条目：

```yaml
- id: llm-github-copilot
  config:
    oauthTokenEnv: GITHUB_COPILOT_OAUTH_TOKEN
```

实际使用的 grant 仍位于 `llm-pi-ai/github-copilot`；此选项不会创建第二个账号或提供方。[凭据详情](docs/USER_GUIDE.zh.md#凭据与配置)。

## 更多

- [故障排查、代理与旧版迁移](docs/USER_GUIDE.zh.md#故障排查)
- [开发、本地部署与回滚](docs/USER_GUIDE.zh.md#开发与本地部署)
- [开发及发布工作流](docs/WORKFLOW.md)
- [为何只提供凭据](docs/adr/0002-narrow-to-credential-provider.md) · [更新记录](CHANGELOG.md) · [MIT 许可证](LICENSE)
