# DeepSeek Harness 0.2.2-rc.5 兼容性评估

> 上文至「本次验证与限制」是实施前的评估快照；实施结果见文末，当前发布状态以 npm 为准。

## 基线与结论

- 插件：本仓库 `v0.4.13`（`3462d5f`），也是 npm 当时的最新发布版；已声明支持到 Harness `0.2.2-rc.1`。
- Harness：npm `latest` / `next` 均为 `0.2.2-rc.5`（2026-11-18 发布）；`alpha` 为 `0.2.3-alpha.2`（2026-11-22 发布）。本地上游 `master` 为 `4b399c39a6`，对应后者标签。两者都是预发布版，不应将 `latest` 误称稳定版。
- 主要对比 [`dsh-v0.2.2-rc.1`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.1) 与 [`dsh-v0.2.2-rc.5`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5)，另对 [`dsh-v0.2.3-alpha.2`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.3-alpha.2) 做静态预览。

**建议先做小范围兼容性维护；目前没有发现 rc.5 必须修改认证运行时代码的证据。** `0.2.2-rc.5` 的隔离浏览器冒烟测试已通过，但未覆盖真实账号或推理，也不能代替所有旧版及中间版回归。`0.2.3-alpha.2` 尚未经端到端测试，不建议宣布支持。

版本来源：[Harness npm 元数据](https://registry.npmjs.org/@deepseek-ai%2fdsh)、[插件 npm 元数据](https://registry.npmjs.org/@lujianjun19%2fdsh-llm-github-copilot)。dist-tag 是核查时快照。

## 已核查的接口

1. `llm-pi-ai` 的 `auth.ts` 和 `login.ts` 在 rc.1、rc.5、alpha.2 的 Git 内容完全相同；[record scope 与 key](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/llm/llm-pi-ai/src/auth.ts) 仍为 `llm-pi-ai/github-copilot`，插件现有 OAuth grant 格式和写后回读检查应保留。下游认证格式并无版本保证，源码未变也不等于已实测真实 Copilot 请求。
2. rc.5 的 [`credentials-local`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/credentials/credentials-local/src/index.ts) 对文件来源的 `describe()` 新增可选 `masked` 预览；引用的读写和环境回退语义不需插件为此迁移。插件只使用 `writable` 等信息，不应为了新字段改变认证行为。
3. rc.5 的 [Remote 事件列表](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/api/remotes/src/remote-events.ts) 保留 `credentials/reference-updated`；Settings 图标插槽和插件设置页在下面的浏览器测试中正常。Renderer、session 等有其他改动，不能由单个测试推断全部接口均未变化。
4. rc.5 有 route 的模型发现、流处理等改动，但这些属于 consuming route，不应移入插件。上游 `llm-pi-ai` 虽注册了原生授权 flow，本次检查生产代码中的 `authorization.begin()` 仍只发现 DeepSeek 账号入口；不能据此认定默认 Web 已有通用 Copilot 授权界面或可以移除此插件。参见 [flow 注册](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/llm/llm-pi-ai/src/login.ts)和 [DeepSeek 账号调用](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/credentials/deepseek-account/src/index.ts)。

## 建议更新

### 优先：支持和回归 `0.2.2-rc.5`

- 在 `.github/workflows/ci.yml` 的阻塞矩阵中加入 `0.2.2-rc.5`，保留 rc.1 和既有旧版本。`scripts/test-harness.mjs` 已接受该精确版本；可将默认版本从 rc.1 更新到 rc.5，并同步 `docs/WORKFLOW.md`。
- 将 Harness 开发依赖和 `package-lock.json` 更新至 rc.5 后运行完整测试。现有 `^0.2.2-rc.1` peer 范围按 npm 默认 SemVer 已匹配 rc.2–rc.5，不需要仅为 rc.5 再加 peer 分支。此范围的可解析性不等于这些版本已测试或已支持。
- 在回归与范围决策完成后，同步 `README.md`、`README.zh.md`、两份 `docs/USER_GUIDE`、`AGENTS.md` 和工作流中的支持声明。rc.2、rc.3、rc.4 此次未单独测试：若要承诺整个 rc.1–rc.5 区间，应补充相应版本验证，而不是由 rc.5 结果推断中间版本。
- 建议补充 `/copilot-login`、`/copilot-status`、`/copilot-logout` 命令和会话输入 overlay 的浏览器回归。现有 smoke 只从设置页操作，不覆盖命令入口；可选再用真实账号验证设备授权与下游 Copilot 推理。

### 后续预览：`0.2.3-alpha.2`

- 这不是 npm `latest`，现有测试脚本拒绝 `0.2.3-alpha.*`。如需预览，单独调整版本校验和 `iconSlot` 判断（目前只把 `0.2.2-*` 识别为新插槽），先运行非阻塞测试，不要自动扩大正式支持范围。
- 上游 [Connection](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.2/packages/client/connection/src/index.ts) 将浏览器认证拆为可注册的认证服务，`/api` 仍声明 `auth: 'required'`。应复测未认证请求 401、已认证请求、设备流及退出，不能只看 Fetch 注册签名。
- 上游 [Settings slot](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.2/packages/client/ui-settings/src/client/contract/slots.ts) 增加 `settings.section.view`，页面还可能投影到 Plugins 页面；`settings.section` 与 icon slot 仍存在。应检查两处页面、图标、关闭动作和多次挂载，而不是提前认定需要改写 UI。
- npm 默认 SemVer 下，当前 DSH peer `^0.2.2-rc.1` 不匹配 `0.2.3-alpha.2`，Cordis peer `^4.0.4` 也不匹配其 `4.2.0-alpha.1`；Harness 自身的 prerelease 判断与 npm 不同。Harness alpha 的 Node 要求是 `^24.22.3 || >=26.13.1`，本次测试机 `24.22.1` 不满足；Cordis 和 Schemastery 也进入新的 alpha 版本线。正式支持前需单独评估 peer、工具库和运行时兼容性，而不是仅放宽测试脚本。

来源：[alpha npm 元数据](https://registry.npmjs.org/@deepseek-ai%2fdsh/0.2.3-alpha.2)、本仓库 `package.json`、`scripts/test-harness.mjs`；SemVer 结果使用 npm 自带的 `semver.satisfies` 检查。

## 本次验证与限制

执行 `npm run test:harness -- 0.2.2-rc.5`：**通过**。测试在独立临时 `DSH_HOME` 安装 npm 发布的精确 Harness 和打包插件，验证配置、依赖、Host/Web 启动、未认证 API 401、设置页图标、环境 token 退出提示、fixture 设备码登录和退出；浏览器无未捕获异常。测试使用模拟 GitHub 响应，没有使用真实 GitHub 凭据或进行 Copilot 推理，也未覆盖 slash 命令、中文界面或 rc.2–rc.4。

rc.5 源码对比依据上述固定标签；alpha 仅作静态对比，**未运行**完整安装或浏览器测试。未修改现有用户 profile，未发布插件。

## 实施结果（2026-11-26，发布前快照）

> 上文保留为实施前评估快照；以下是本分支的结果，远端 CI 尚未运行。

- 开发依赖和 lockfile 已更新至 `0.2.2-rc.5`，peer 范围和运行时认证代码未改。CI 增加 `0.2.2-rc.5` 阻塞项，保留 rc.1 与既有旧版本；默认 smoke 版本改为 rc.5。
- 隔离打包、Host 和 Chromium 检查已通过 `0.1.7-rc.1`、`0.2.0-rc.2`、`0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.5`，以及全部 `0.2.2-rc.1`–`0.2.2-rc.5`。新增真实聊天界面操作：未登录/已登录状态命令、设备码弹窗及自动关闭、退出确认。GitHub 响应仍为 fixture，没有真实账号或推理验证。
- rc.5 新建空会话中，`/copilot-status` 成功并发出 `command/done`，但当时的空会话页面没有显示结果；测试据此验证会话事件，不宣称验证了可见的状态回执。本插件未修改 Harness 核心。
- 测试的 Web 进程 `HOME` 与工作区改为临时目录；成功后清理，失败时保留诊断文件，不使用或修改现有 profile。`0.2.3-alpha.2` 仍只做静态预览，不在支持范围或 CI 矩阵中。
