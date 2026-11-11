# GitHub Copilot 插件使用指南

[快速开始](../README.zh.md) · [English](USER_GUIDE.md)

## 兼容性

支持的 Harness 版本：`0.1.7-rc.1`–`0.1.7-rc.2`、`0.2.0-rc.1`–`0.2.0-rc.2`、`0.2.1-rc.2`–`0.2.1-rc.5`，以及 `0.2.2-rc.1`。不支持 alpha 版本；npm 持续变化的 dist-tag 不是支持承诺。

[manifest](../package.json) 声明的 DSH peer 范围为 `^0.1.7-rc.1 || ^0.2.0-rc.1 || ^0.2.1-rc.2 || ^0.2.2-rc.1`，Cordis 为 `^4.0.4`。开发基线是 Harness `0.2.2-rc.1` / Cordis `4.1.0`。证据和验证边界见[兼容性评估](dsh-v0.2.1-rc.3-compatibility-analysis.md)。

## 安装与更新

命令均针对 `web` profile：默认路径是 `~/.dsh/profiles/web`，设置 `DSH_HOME` 时为 `$DSH_HOME/profiles/web`。使用 `dsh plugin` 保持 pnpm lockfile 和 bundle 列表同步，不要混用 `npm install`。

安装仓库默认分支（可能尚未发布）：

```sh
dsh plugin --profile web add github:lujianjun19/dsh-llm-github-copilot -w
```

若 pnpm 要求构建批准，将**提示中的精确键名**加入 profile 的 `pnpm-workspace.yaml` 中的 `allowBuilds`，然后重试，不要猜测键名。

安装指定版本或通过包管理器回退时，替换 `X.Y.Z`：

```sh
dsh plugin --profile web add @lujianjun19/dsh-llm-github-copilot@X.Y.Z -w
```

pnpm 的 `minimumReleaseAge` 策略可能延迟新版本安装。确需放行时，仅将目标包和版本加入该 workspace 文件的 `minimumReleaseAgeExclude`，然后按精确版本安装；`@latest` 仍可能选中旧版。

检查实际安装版本：

```sh
dsh plugin --profile web list @lujianjun19/dsh-llm-github-copilot
```

安装器会向 `dsh.profile.bundles` 添加 bundle 并加载其 `cordis.patch.yml`。如有旧的手动插件 `insert`，请删除而非重复注册。更新后重启 DSH 并硬刷新浏览器。

## 凭据与配置

- 设备流将 grant 写入 `llm-pi-ai/github-copilot`，并在配置的引用可写时保存一份副本。grant 格式、token 交换与刷新、账号端点选择由消费方路由负责。
- 凭据服务挂载时，**仅在不存在可用 OAuth grant 时**沿用配置的引用/环境变量 token。已有 grant 优先于引用；不会覆盖只读引用。
- 应使用兼容 Copilot OAuth 流程取得的 token。插件不校验 token 前缀，也不保证任意 PAT 或 `gh auth login` token 都有 Copilot 权限。
- `/copilot-status` 检查存储而非 GitHub API。仅在路由写入 `availableModelIds` 后报告模型数量，不会请求或列出模型。
- 退出删除 grant 和可写引用。环境变量/`.env` 或外部来源仍可能提供 token，此时 API 返回 `credentialRemaining: true`，不会返回 token 本身。请移除外部 token、重启并执行 `/copilot-logout`，否则启动时可能再次沿用。GitHub 授权不会被撤销。
- `oauthTokenEnv` 是 Loader 管理的实时选项，保存在活动 profile 的 `cordis.patch.yml`，而非 `settings.yaml`。使用 [README 中的覆盖配置](../README.zh.md#可选配置)，不要重复 `insert`。修改引用不会移动 grant 或创建另一个账号；模型、端点和请求选项在 Harness 的 `llm-pi-ai` 条目下配置。

## 故障排查

### 已登录但没有 Copilot 模型

在 **设置 → 模型** 中配置内置 `github-copilot` 提供方；反复登录不会添加提供方。如果连插件页面都没有，请检查安装版本和 bundle 注册，然后重启 DSH 并硬刷新。

### 模型缺失、请求被拒绝，或退出后仍可见

选择器来自 Harness 路由的目录/配置，不是实时账号权限校验。检查实际请求错误及账号/组织的模型策略。删除凭据不会删除提供方配置；插件不能扩展目录，也不能把所有模型缺失归因于 IP 限制。参见[模型列表跟踪问题](issues/github-copilot-model-list-refresh.md)。

### 网络错误或设备码一直等待

检查能否访问 GitHub。设备流支持 `https_proxy`/`HTTPS_PROXY`/`http_proxy`/`HTTP_PROXY`（HTTP(S) 代理 URL），以及按主机名匹配的 `no_proxy`/`NO_PROXY`。这**不是** Harness 路由的模型请求代理配置。

轮询会重试临时失败直到过期。等待中执行 `/copilot-login` 会复用同一设备码；过期或拒绝后再重新发起。关闭对话框不会取消 Host 轮询。

### token 交换失败或被吊销

短期 Copilot token 由 Harness 路由刷新。长期 GitHub token 被吊销或不可用时需重新登录：移除外部 token 来源，退出登录，再执行 `/copilot-login`。

### 重复提供方或旧适配器安装

若出现 `configurable provider "github-copilot" is already declared`，检查重复提供方配置、旧适配器注册，以及 bundle 之外遗留的手动插件 `insert`。保留一份 bundle 注册，内置提供方也只配置一次。

从插件 `0.4.5` 或更早版本升级时，将设置和会话中的 `github-copilot-official` 改为 `github-copilot`，并从当前目录选择模型。已有有效 token 引用会自动沿用，无需再次登录。

## 开发与本地部署

在仓库根目录操作，修改 `src/host/` 和 `src/client/`，不要编辑生成的 `lib/`。遵循[分支、测试、PR 和发布工作流](WORKFLOW.md)。

```sh
npm ci
npm run build
npm test
npm run check
npx playwright install chromium
npm run test:harness -- 0.2.2-rc.1
```

Harness 检查使用临时 `DSH_HOME`、打包安装、Chromium 和模拟 GitHub 响应，不使用你的凭据，也不发起真实 Copilot 推理。完整版本矩阵及测试选项见 [WORKFLOW.md](WORKFLOW.md)。

首次安装当前 checkout 时，先构建，再注册 bundle：

```sh
dsh plugin --profile web add . -w
```

全部检查通过后，可选部署到本地 Web profile：

```sh
npm run deploy
```

deploy 会构建、执行产物测试，并原子复制发布文件和运行时依赖，保留回滚备份；不会执行 `npm install` 或注册缺失的 bundle。Host 变更需重启 DSH，Client 变更需硬刷新。

### 回滚本地部署

deploy 在 `${DSH_HOME:-$HOME/.dsh}/plugin-backups/dsh-llm-github-copilot/` 下保留最多五份备份，目录名含版本与时间戳。停止 DSH，并在执行前替换 `<backup-directory>`：

```sh
PLUGIN="${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/@lujianjun19/dsh-llm-github-copilot"
BACKUP="${DSH_HOME:-$HOME/.dsh}/plugin-backups/dsh-llm-github-copilot/<backup-directory>"
test -d "$BACKUP" && mv "$PLUGIN" "${PLUGIN}.before-rollback-$(date +%Y%m%d%H%M%S)" && cp -a "$BACKUP" "$PLUGIN"
dsh web
```

这只恢复包文件，不恢复 profile manifest 或 lockfile。npm/GitHub 管理的安装应改用上文的指定版本安装命令。
