# GitHub Copilot 插件安装手册 — `dsh-llm-github-copilot`

本插件为 DeepSeek Harness (DSH) 增加 `github-copilot-official` 提供者：通过 GitHub
OAuth **设备码登录**（浏览器 + 口令）拿到 token，自动交换成 Copilot API token（含缓存与
过期前自动刷新），并**动态发现全部 Copilot 模型**，走 OpenAI 兼容的 chat-completions 接口。

---

## 0. 前提

- 已安装 DeepSeek Harness，`dsh` 命令可用。
- Node.js ≥ 20（dsh 0.1.0-rc.6 实际要求 Node 24）。
- （可选）已安装 `pnpm`，仅「方式 B」需要。

---

## 1. 获取插件文件

两种方式任选其一：

- 拷贝整个目录 `dsh-llm-github-copilot/`（含 `package.json`、`lib/index.js`）；
- 或解压 `dsh-llm-github-copilot-0.1.0.tgz`。

---

## 2. 安装到 profile

> 下面统一以 `web` profile 为例；其它 profile 同理，把 `web` 换成对应名字即可。
> `$DSH_HOME` 默认是 `~/.dsh`。

### 方式 A — 手动拷贝（已实测，最稳妥）

```bash
mkdir -p "$DSH_HOME/profiles/web/node_modules/@deepseek-ai"
cp -r ./dsh-llm-github-copilot \
      "$DSH_HOME/profiles/web/node_modules/@deepseek-ai/dsh-llm-github-copilot"
```

> 必须用「真实目录拷贝」，不要用软链接（`ln -s`）。Node 会跟随软链接到原始位置去解析
> 依赖，从而找不到 `@deepseek-ai/*` 等包；真实目录会让 Node 沿父目录一路找到
> `$DSH_HOME/profiles/node_modules` 里 DSH 自带的依赖。

### 方式 B — pnpm 管理（推荐用于长期维护）

```bash
dsh plugin --profile web add "file:$PWD/dsh-llm-github-copilot"
# 或使用 tarball：
dsh plugin --profile web add "/绝对路径/dsh-llm-github-copilot-0.1.0.tgz"
```

`dsh plugin add` 会在 profile 目录内执行 `pnpm add`（`file:` 协议会复制包到 profile 的
`node_modules`），并自动维护 `package.json` 依赖与 bundle 列表。

---

## 3. 挂载到组合（composition）

编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`，在其末尾追加：

```yaml
- insert:
    - id: llm-github-copilot
      name: '@deepseek-ai/dsh-llm-github-copilot'
```

若文件当前是空数组 `[]`，整体改为：

```yaml
- insert:
    - id: llm-github-copilot
      name: '@deepseek-ai/dsh-llm-github-copilot'
```

---

## 4. 使其生效（重要：必须重启）

**新增一个插件包时，请直接重启 dsh。** 热加载（HMR）对「已加载插件的配置改动」可靠，但对
「运行时新增一个全新插件包」并不可靠 —— 实测经常加载不进当前进程，典型症状就是模型不出现。

### 4.1 代理说明（重要，否则看不到 Claude）

GitHub 会按**出口 IP/地区**决定是否提供完整模型目录：走代理出口（例如本机
`http://127.0.0.1:10808`）时返回全部模型（含 Claude、gpt-5.6 等 42 个）；直连受限地区时
只返回 32 个且**没有 Claude**。

插件**已内置代理支持**（自带 undici ProxyAgent，自动读取 `https_proxy`/`HTTPS_PROXY`/
`http_proxy`/`HTTP_PROXY` 和 `NO_PROXY`），所以只要 shell 环境里配了代理（或有
`export HTTPS_PROXY=http://127.0.0.1:10808` 这类设置），**直接 `dsh web` 即可**，不需要
任何额外标志。没有代理的机器也是直接 `dsh web`。

> 备选：也可以用 Node 启动标志 `NODE_USE_ENV_PROXY=1 dsh web`（作用与插件内置代理相同，
> 二者择一即可，同时用也没问题）。

### 4.2 重启命令

```bash
# 停掉正在跑的 dsh web（Ctrl+C），再重新启动
dsh web
```

> 如果你坚持不重启：长驻进程会监听 `cordis.patch.yml` 改动；若因「先写 composition、后放包」
> 的顺序导致加载失败，可先删掉该行、等 2 秒、再写回，强制 loader 重新导入。但这只是补救，
> 新增插件仍以重启为准。

---

## 5. 登录 GitHub Copilot

在 Web 聊天输入框运行：

```
/copilot-login
```

按提示操作：

1. 用浏览器打开它给出的 URL（`https://github.com/login/device`）。
2. 输入它给出的口令（形如 `XXXX-XXXX`）。
3. 授权该 GitHub App（会显示为 **VS Code**）并完成登录。

后台会自动轮询授权、交换 token 并保存，你**不需要回贴任何 token**。之后运行
`/copilot-status` 可查看认证状态与模型清单。

### 备选：手动提供 GitHub token（跳过设备码登录）

向凭据文件写入（`$DSH_HOME/.credentials.yaml`，权限 0600）：

```yaml
GITHUB_COPILOT_OAUTH_TOKEN: "<你的 GitHub token>"
```

或在启动 dsh 前导出环境变量：

```bash
export GITHUB_COPILOT_OAUTH_TOKEN="<你的 GitHub token>"
dsh web
```

支持的 token 类型：

- `gho_` — OAuth token（`gh auth login` 默认产出）
- `github_pat_` — fine-grained PAT（需勾选 **Copilot** 权限）
- `ghu_` — GitHub App user token（VS Code 客户端产出）

**不支持** `ghp_`（经典 PAT，GitHub 已拒绝其用于 Copilot API）。

---

## 6. 验证

- 运行 `/copilot-status`，应显示「authenticated」并列出模型。
- 会话的模型选择器中出现 **GitHub Copilot**，即可选用其全部模型。

---

## 常见问题（FAQ）

- **Q：已经授权了 GitHub，但模型选择器里看不到 "GitHub Copilot"？**
  A：几乎都是因为当前进程没加载新插件。**重启 `dsh web`** 即可（token 已存好，无需重新登录）。

- **Q：能看到 Copilot 模型，但没有 Claude（或模型明显偏少）？**
  A：这是**出口 IP 被限制**。GitHub 只对「认可的出口」返回完整目录（含 Claude）；
    直连（中国等受限地区 IP）只给 32 个且无 Claude。插件会自动走 shell 环境里的
    `HTTP(S)_PROXY` 代理（无需额外标志），但**必须重启 dsh 让新代码生效**；若仍没有
    Claude，确认 shell 里有 `export HTTPS_PROXY=http://127.0.0.1:10808` 之类的代理配置后
    再重启一次。

- **Q：`/copilot-login` 报网络错误或一直等待？**
  A：设备码轮询偶发网络抖动；重新运行一次 `/copilot-login` 拿新口令即可（旧口令会随之失效）。

- **Q：启动时报 `configurable provider "github-copilot" is already declared`？**
  A：说明用了旧版路由名 `github-copilot`（与内置 pi-ai 冲突）。本版已改为
  `github-copilot-official`；确认 `cordis.patch.yml` 里的 `id`/`name` 与本手册一致。

- **Q：token 过期了怎么办？**
  A：不用管。底层保存的是长期 GitHub OAuth token；短时效 Copilot token 由插件自动缓存、
    过期前自动刷新。只有主动登出/吊销后才需要重新 `/copilot-login`。

---

## 可选配置（`$DSH_HOME/settings.yaml` 的 `llm-github-copilot:` 段）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `oauthTokenEnv` | `GITHUB_COPILOT_OAUTH_TOKEN` | 凭据引用（一般不用改） |
| `baseURL` | 自动 | 覆盖 API 主机；默认取 token 交换返回的 `endpoints.api`，回退 `https://api.githubcopilot.com` |
| `models` | `[]`（自动发现） | 静态模型列表（`id`/`name`/`contextWindow`/`maxTokens`），为空则动态发现 |
| `defaultContextWindow` | `262144` | 模型未声明上下文窗口时的兜底 |
| `defaultMaxTokens` | `32768` | 模型未声明输出上限时的兜底 |
| `streamIdleTimeoutMs` | `300000` | 流式读取空闲超时 |
| `retryPolicy` | 正常策略 | 重试策略 |

示例：

```yaml
llm-github-copilot:
  defaultContextWindow: 200000
```

---

## 注意事项

1. **提供者路由名是 `github-copilot-official`**（而不是 `github-copilot`），目的是避开
   DSH 内置 pi-ai 目录里已有的同名 `github-copilot` 路由，避免 `already declared` 冲突。
2. **OAuth 客户端 ID** 使用 VS Code 官方公共客户端 `Iv1.b507a08c87ecfe98`（与 Copilot CLI
   一致），无需你自建 GitHub OAuth App。旧客户端 `Ov23...` 产出的 token 无法交换 Copilot
   token，请勿使用。
3. Copilot 返回的短时效 token（约 30 分钟）由插件**自动缓存并在过期前刷新**，你无需手动
   续期；底层保存的是长期有效的 GitHub OAuth token。
4. **同时支持两种 API**：`/chat/completions`（claude-*、gemini-*、kimi-*、gpt-4o 等）和
   OpenAI `/responses`（gpt-5.4-mini、gpt-5.5、gpt-5.6-* 只走这个接口）。插件按模型的
   `supported_endpoints` 自动路由，因此 gpt-5.6 这类模型也能直接用。
5. **推理等级（reasoning effort）按模型定义，且各不相同**：插件发现模型目录时会读取每个
   模型自己声明的等级集合（`supports.reasoning_effort`），所以在设置界面里能选的等级因模型
   而异。例如：
   - `gpt-5.6-*`：Off / Low / Medium / High / Extra high / Max；
   - `gpt-5.4-mini`、`gpt-5.5`：Off / Low / Medium / High / Extra high；
   - `kimi-k3`：Low / High / Max；`gemini-3.x`：Low / Medium / High；
   - `claude-*`：Low / Medium / High（走 Anthropic 自适应思考 `thinking.effort`，不支持
     `reasoning_effort`——对 Claude 传该字段会被 API 以 400 拒绝）；
   - `gpt-4o` 等不声明任何等级 → 设置界面不提供该选项，显式设置会被 DSH 校验拒绝。
   不设置等级时，请求不带推理参数、使用 API 默认行为。
4. **Business/Enterprise 账号的 API 主机不同**：token 交换会返回账号专属主机（例如
   Business 为 `https://api.business.githubcopilot.com`，Enterprise 为
   `https://api.enterprise.githubcopilot.com`，个人为 `https://api.githubcopilot.com`）。
   插件会**自动采用**交换结果里 `endpoints.api` 的值；**不要**手动把 `baseURL` 固定成个人账号
   的主机，否则 Business/Enterprise 账号会请求失败。
