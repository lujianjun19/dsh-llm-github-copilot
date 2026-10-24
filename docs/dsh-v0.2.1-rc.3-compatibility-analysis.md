# DeepSeek Harness 0.2.1 compatibility assessment

核查时间：2026-10-24（UTC）。

> 下文 §1–6 和原始「验证与边界」保留为**实施前的评估快照**，其中的「当前范围」、
> 「待办」和测试数量描述当时的 `0.4.10`。后续实现与验证结果见文末「实施结果」，
> 当前支持范围以 `package.json` 和 README 为准；本次尚未发布。

## 核查范围与结论

- 插件已发布版本：`0.4.10`；开发依赖仍以 Harness `0.2.0-rc.2` 为基线。
- npm `@deepseek-ai/dsh`：`latest = 0.2.1-rc.2`，`next = 0.2.1-rc.3`。
- 上游源码：默认分支为 **`master`**，核查固定在
  [`22ddee3792402c3e70ec5f86a63c3e3e895a2f60`](https://github.com/deepseek-ai/deepseek-harness/commit/22ddee3792402c3e70ec5f86a63c3e3e895a2f60)。
- 同时检查了 npm 发布的 `llm-pi-ai@0.2.1-rc.2` / `0.2.1-rc.3`，以及
  `0.2.1-rc.3` 的 credentials、credentials-local、settings、client-connection、
  api-remotes、ui-commands、ui-primitives、app-boot 和 plugin-manager 包。

**建议进行小范围兼容性维护，但没有发现必须重写核心认证逻辑的证据，插件也还不应废弃。**
更新重点是明确支持范围与测试基线、补充真实凭据服务测试，以及修正环境变量退出反馈和
一个已有的 UI 可访问性缺口。不能仅因为包版本号变化就重写 grant、注册新适配器或接管模型目录。

版本来源：[DSH npm 元数据](https://registry.npmjs.org/@deepseek-ai%2fdsh)、
[插件 npm 元数据](https://registry.npmjs.org/@lujianjun19%2fdsh-llm-github-copilot)。
这些 dist-tag 仅代表核查时的状态。

## 1. 版本范围：npm 与 Harness 自身不是同一套判断

插件各 DSH peer 的当前范围为 `^0.1.7-rc.1 || ^0.2.0-rc.1`。

| 检查方式 | `0.2.1-rc.2` | `0.2.1-rc.3` |
| --- | --- | --- |
| `semver.satisfies(version, range)`，npm 默认语义 | false | false |
| `semver.satisfies(version, range, { includePrerelease: true })` | true | true |
| 上游 `evaluatePluginCompatibility(manifest, {}, version)` | 接受 | 接受 |

**不能从默认 SemVer 不匹配，推导出“最新版一定被 Harness 安装/启动门禁拦截”。**
Harness 的 `satisfies()` 明确启用了 `includePrerelease: true`，发布的
`dsh-app-boot@0.2.1-rc.3` 也是如此；npm/pnpm 的 peer 解析仍需与此区分。
通过 Harness 门禁更不等于行为已经验证。

建议验证后为正常 peer 解析显式添加 `0.2.1` RC 范围，并将开发依赖/lockfile 和测试
迁移到目标发行版，而不是使用版本豁免绕过检查，或宣称所有未来预发布版都兼容。

来源：[plugin-compatibility.ts](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/boot/app-boot/src/plugin-compatibility.ts#L51-L101)、
[app-boot 发布元数据](https://registry.npmjs.org/@deepseek-ai%2fdsh-app-boot/0.2.1-rc.3)。

## 2. 凭据交接格式未变，不需要迁移本插件的 grant

`llm-pi-ai` 仍使用 `RECORD_SCOPE = 'llm-pi-ai'`，通过
`recordKeyFor('github-copilot')` 读取 `llm-pi-ai/github-copilot`。
`grant` 的 payload 仍作为 pi-ai credential 传递。本插件种入的形状仍适用：

```js
{ kind: 'grant', payload: { type: 'oauth', refresh: token, access: '', expires: 0 } }
```

两个受检 route 发布包均声明 `@earendil-works/pi-ai: ^1.1.0`；受检 master 的 lockfile
解析到带 Harness 补丁的 `1.3.0`。另检查了 npm 当时的 pi-ai `latest = 1.4.0`：
`dist/auth/oauth/github-copilot.js` 在 `1.1.0`、`1.3.0`、`1.4.0` 三个发布包间
字节相同。Harness 的 `1.3.0` 补丁只改 wire 处理，未修改这个 OAuth 文件。
短期 token 交换、刷新及账号端点推导仍由下游负责。

credentials-local 改变存储文件/环境层优先级不要求插件直接迁移文件；本插件调用凭据
服务，不自行解析或改写凭据文件。保留 `storeRawOAuthToken()` 的写入后回读检查。

来源：[auth.ts](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/llm/llm-pi-ai/src/auth.ts#L29-L90)、
[route 发布元数据](https://registry.npmjs.org/@deepseek-ai%2fdsh-llm-pi-ai/0.2.1-rc.3)、
[pi-ai 1.3.0 OAuth 源码](https://unpkg.com/@earendil-works/pi-ai@1.3.0/dist/auth/oauth/github-copilot.js)、
[Harness pi-ai 补丁](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/patches/%40earendil-works__pi-ai%401.3.0.patch)。

## 3. 当前插件仍有存在价值：原生 flow 尚无通用 Web 入口

base bundle 仍挂载 `dsh-authorization`，`llm-pi-ai` 也仍注册各 provider 的原生
登录 flow，包括 Copilot。但在受检源码的 credentials、api、client 和 llm-pi-ai
生产代码中，`authorization.begin()` 调用仍只有 DeepSeek-account 专用实现；Remote
也没有暴露供任意 pi-ai provider 使用的通用 authorization 入口。

所以不能把“存在 AuthorizationService / 原生 flow”误认为“默认 Web 已能完成 Copilot
登录”。ADR-0002 的退出条件仍未满足：暂时保留本插件的设备流页面、端点和命令，
也不要为同一个 credential key 注册第二条原生授权 flow。

来源：[base bundle](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/bundle/base/cordis.patch.yml#L117-L118)、
[pi-ai flow 注册](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/llm/llm-pi-ai/src/login.ts#L123-L174)、
[实际 begin 调用](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/credentials/deepseek-account-platform/src/index.ts#L425)。

## 4. Host / Web 所用主要 API 仍存在

| 本插件使用的接口 | 受检版本中的情况 |
| --- | --- |
| `Config.oauthTokenEnv` 的 `.volatile()` / `.get()` | 继续可用 |
| `settings.configure({ auto: false }, ctx.fiber)` | 签名保留 |
| `connection.fetch.register({ path, methods, requestBody, fetch })` | 签名保留，继续使用受认证的 `/api` 通道 |
| credentials 的 reference 与 record 读写 | 接口保留 |
| `credentials/reference-updated` | 仍由 Remote 转发；record 事件也转发 |
| `command/executed`、`commandUi.decorate()` | 接口保留 |
| `sessions.binding(sessionId)`、list slot 注册 | 接口保留 |

没有发现需要重新引入 `@deepseek-ai/dsh-llm` 或改回裸 `webServer` 路由的理由。

来源：[settings API](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/settings/settings/src/index.ts)、
[Connection Fetch 合约](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/client/connection/src/rpc.ts)、
[Remote 事件清单](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/api/remotes/src/remote-events.ts#L37-L38)、
[command UI 服务](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/client/ui-commands/src/client/service.ts)。

## 5. 环境变量 token：新版本改变了退出后的表现

`credentials-local@0.2.1-rc.3` 对环境来源 reference 的 `describe()` 返回
`writable: true`。`set()` 将覆盖值写入托管文件，`unset()` 只删除该文件中的值；
不能清除启动进程继承的环境变量，删除文件值后仍会回退到环境层。

在真实 `LocalCredentialProvider` 上复现：

1. 启动环境提供虚构的 `GITHUB_COPILOT_OAUTH_TOKEN`。
2. 插件成功写入 grant，同时因 reference 可写而保存文件副本。
3. `/copilot-logout` 返回成功，grant 和文件 reference 确实删除。
4. 但环境 fallback 仍存在；随后 `/copilot-status` 又报告 `authenticated`。

这不破坏凭据写入，但会造成用户看见“退出成功”后又“已登录”。建议补充回归测试，并在
退出反馈中区分“本机存储已清除”和“启动环境仍提供 token”，提示移除变量并重启。
不要试图由插件修改父进程环境，也不要删除 provider 配置来伪装退出。

来源：[credentials-local 分层规则与写入实现](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/credentials/credentials-local/src/index.ts)、
本仓库 `src/host/12-apply.js` 中的 `storeRawOAuthToken()`、`logout()` 和 `authStatus()`。

## 6. 一个已有 UI 缺口，以及仍不应接管的模型目录

- `RiskConfirmationProps.closeLabel` 是必填。本插件设置页的 `RiskConfirmation` 调用
  未传它，导致关闭按钮缺少本地化的 accessible name。建议补上 `closeLabel: text('close')`。
  这在原 `0.2.0-rc.2` 类型定义中也已必填，不应误报成 `0.2.1` 新引入的破坏性变更。
- `0.2.1` 的 `listModels()` 新增了显式 `apiKeyEnv` 缺失检查。但没有显式引用时，
  `resolveApiKey()` 直接返回 `undefined`，让 pi-ai 使用自己的认证。因此，这个检查不等于
  已实现 Copilot grant 登出门控或按 `availableModelIds` 实时过滤模型选择器。
  模型可见性仍应由 consuming route 修复，不能移回本插件。

来源：[RiskConfirmationProps](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/client/ui-primitives/src/RiskConfirmation.tsx#L9-L22)、
本仓库 `src/client/07-settings-page.js`、
[最新 listModels](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/llm/llm-pi-ai/src/adapter.ts#L295-L310)、
[resolveApiKey](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/llm/llm-pi-ai/src/index.ts#L188-L210)。

## 验证与边界

所有实验均在 `/tmp/copilot-latest-compat/` 内，未修改已安装 profile、未使用真实 token、
未修改本仓库的依赖版本或 lockfile，也未发布。

- 将当前工作树的测试/源码复制到隔离目录，Host 直接使用的 credentials、
  launch-environment 换成 `0.2.1-rc.3`，Cordis 使用 `4.0.5`，Schemastery 使用 `3.18.5`：
  **现有 32 项测试全部通过**。其中许多是静态或 stub-context 测试，不是完整 Harness 启动测试。
- 额外通过真实 `Context + LocalCredentialProvider@0.2.1-rc.3` 跑了
  **2 项冒烟测试**：文件 reference 沿用/退出、环境 token 沿用/退出。
  前者正常，后者确认上文的环境 fallback 现象。
- 实际调用上游固定提交的 `evaluatePluginCompatibility()`，确认当前 manifest 对两版
  `0.2.1` RC 都返回接受；同时对照了发布包中的相同 SemVer 选项。
- **未完成**完整 Web profile 启动、浏览器交互、真实 GitHub 设备流和 Copilot 推理请求；
  也没有把 `0.2.1-rc.2` 的整套依赖独立跑一遍。因此不能据此宣布两个 RC 都已端到端支持。

下一步应在独立的兼容性实现分支上更新依赖/支持声明，落地上述回归与提示修正，完成
目标发行版的完整启动和登录测试，再考虑发布。是否发布仍需用户明确授权。

## 实施结果（2026-10-24，未发布）

实施分支：`fix/harness-0.2.1-compat`。

- 已显式加入 peer 分支 `^0.2.1-rc.2`，保留原有版本线；开发依赖与 lockfile 以
  `0.2.1-rc.3` / Cordis `4.0.5` / Schemastery `3.18.5` 为基线。
- 已修正退出逻辑：删除 consuming-route grant，清除可写 reference，跳过只读引用的
  `unset()`；再读取实际状态。仍存在外部 token 时，API 返回 `credentialRemaining: true`，
  命令与中英文设置页均说明外部 token 残留及移除/重启步骤，不再宣称已完全退出。
- 已补齐设置页 `RiskConfirmation` 的本地化 `closeLabel`。
- 已将真实 credentials-local 的沿用/退出、环境 fallback、自定义 `.env` 引用、已有 grant
  优先级及中英文 primitive 调用契约纳入正式测试；当前共 **38 项测试**。
- 已新增 `npm run test:harness -- <exact-version>`：打包插件、安装到临时 profile、
  启动实际发布的 Harness，并通过 Chromium 操作插件页面。`0.2.0-rc.2`、
  `0.2.1-rc.2`、`0.2.1-rc.3` 均已通过本地检查；同一矩阵已写入 CI，尚未推送运行。
- 浏览器覆盖：bundle/依赖/配置可识别、未认证 API 返回 401、环境 token 退出警告、
  正常设备码登录后的状态更新、确认退出与普通 token 清除，以及页面无未捕获 JS 错误。
  旧版只读环境引用与新版文件覆盖后回退的两条链路均使用实际 Harness 验证。

**仍需人工授权的边界：**浏览器测试只在外部 GitHub HTTP 边界使用 fixture，
不访问真实 GitHub 设备授权端点，也不调用 Copilot 推理。真实账号授权及一次实际模型请求
不能由这些自动化测试代替；完成前不应声称已经做过真实账号端到端验证。
运行测试的说明和可选参数见 `docs/WORKFLOW.md`。

本次没有改变 grant 格式，没有新增模型适配器，也没有把模型目录职责移回插件。
