# GitHub Copilot 登出后模型列表未随认证状态更新

## 问题

用户通过本插件登录 GitHub Copilot 后，输入框下方的模型选择器会显示
`github-copilot` 模型。执行 `/copilot-logout` 成功后，长期 OAuth token 和
`llm-pi-ai/github-copilot` grant 都会被删除，但模型选择器仍显示该 provider 的模型。

用户期望：登出后 Copilot 模型自动从输入框下方的模型列表消失；再次登录并完成
凭据交换后，仅显示账户实际可用的模型。

## 已确认的链路（DSH `0.1.5-rc.1`）

1. 本插件登出时调用 `credentials.deleteRecord('llm-pi-ai/github-copilot')`，并删除
   `GITHUB_COPILOT_OAUTH_TOKEN` credential reference。
2. `credentials/reference-updated` 会被 Web Remote 转发。
3. `@deepseek-ai/dsh-client-ui-model-selection` 的 `ModelDirectoryResolver` 监听该事件，
   调用 `session.modelCatalog()` 刷新输入框和 `/model` 共用的目录。
4. 但 `@deepseek-ai/dsh-llm-pi-ai` 的 `PiAiAdapter.listModels()` 只从 provider 的已配置
   catalog 返回模型；它不读取 `llm-pi-ai/github-copilot` grant，也不读取 grant 中的
   `availableModelIds`。

因此，浏览器目录刷新本身正常，但刷新后得到的仍是同一批静态 Copilot 模型。

## 根因

模型目录的认证可用性由 consuming route（`llm-pi-ai`）决定，而当前该 route 的目录
实现没有将 GitHub Copilot grant 的存在或 `availableModelIds` 纳入模型可见性判断。

这不是本插件漏发刷新事件，也不是浏览器缓存问题。

## 推荐修复（DeepSeek Harness）

在 `@deepseek-ai/dsh-llm-pi-ai` 中使 `github-copilot` 的模型目录依赖其 grant：

- 无 `llm-pi-ai/github-copilot` grant 时，不向 `listModels()` / `modelCatalog()` 暴露
  Copilot 模型，或将该 provider 标记为不可路由；
- grant 存在时，以 `availableModelIds` 过滤内置 Copilot catalog；
- 监听 credential record 变更并使模型目录失效，使首次交换完成、登录、登出和 token
  更新都能刷新模型选择器。

该改动应留在 Harness：它拥有 provider 注册、模型目录和 grant payload 的解释权。

## 不采用的替代方案

- **插件登出时删除 `llm-pi-ai.providers.github-copilot` 配置：** 模型会消失，但会丢失
  用户 provider 配置，重新登录后必须重新添加；违反本插件不拥有模型配置的边界。
- **插件通过 DOM / `MutationObserver` 隐藏菜单分组：** 仅视觉隐藏，`/model` 等其他入口
  仍可能显示；依赖 Harness 私有 DOM 结构，升级脆弱。
- **仅强制浏览器刷新：** 目录会重新请求，但 Harness 仍返回静态模型，无法解决问题。
- **运行时 monkey-patch Harness Remote 或 LLM service：** 侵入全局服务且依赖加载顺序，
  比修改 Harness 源码更难维护。

## 验收条件

1. 已登录状态下，模型菜单只显示 grant 的 `availableModelIds` 内的 Copilot 模型。
2. 执行 `/copilot-logout` 后，模型菜单无需刷新页面即可移除 Copilot 分组。
3. 再次登录、grant 完成首次交换后，模型菜单无需刷新页面即可恢复相应模型。
4. `/model` 弹窗与输入框下方模型选择器始终显示相同结果。
5. 没有 GitHub Copilot grant 的其他 `llm-pi-ai` provider 不受影响。
