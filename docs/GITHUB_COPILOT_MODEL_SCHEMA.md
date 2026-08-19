# GitHub Copilot `/models` API — 模型对象 Schema

本文档记录 `GET {baseUrl}/models` 返回的 `data[]` 数组中每个模型对象的完整字段结构，
供后续功能开发参考。数据来自 2026-08-19 对 `api.business.githubcopilot.com` 的实测抓包（共 42 个模型对象）。

---

## 顶层字段

| 字段 | 类型 | 必填 | 示例值 | 说明 |
|---|---|:---:|---|---|
| `id` | string | ✅ | `"gpt-5.4"` | 模型唯一标识符，调用 API 时传给请求体的 `model` 字段 |
| `name` | string | ✅ | `"GPT-5.4"` | 供用户展示的友好名称 |
| `object` | string | ✅ | `"model"` | 固定值，OpenAI 兼容的对象类型标记 |
| `vendor` | string | ✅ | `"Anthropic"` | 模型提供商（`"OpenAI"` / `"Anthropic"` / `"Google"` / `"Moonshot"` / `"Microsoft"` 等） |
| `version` | string | ✅ | `"claude-fable-5"` | 模型内部版本字符串，通常与 `id` 相同 |
| `preview` | bool | ✅ | `false` | `true` = 预览版，功能或定价可能随时变动 |
| `model_picker_enabled` | bool | ✅ | `true` | **是否在 model picker 展示**。`false` = 旧版快照或已下线模型，官方客户端（VS Code Copilot Chat）隐藏这些条目。本插件以此字段作为首要过滤条件。 |
| `model_picker_category` | string | ❌ | `"powerful"` | Picker 分组标签：`"powerful"` / `"versatile"` / `"lightweight"`。旧版或 embedding 模型通常缺失此字段。 |
| `supported_endpoints` | string[] | ❌ | `["/responses", "/chat/completions"]` | 该模型可调用的 API 路径。缺失或空数组表示仅支持旧版 `/chat/completions`。已知值：`"/chat/completions"` / `"/responses"` / `"/v1/messages"` / `"ws:/responses"`（WebSocket 流式，暂未支持）。 |

---

## `policy` 对象

账号对该模型的访问策略，旧版/未授权模型通常缺失此对象。

| 字段 | 类型 | 必填 | 示例值 | 说明 |
|---|---|:---:|---|---|
| `policy.state` | string | ❌ | `"enabled"` | 策略状态。`"enabled"` = 当前账号可用；缺失 = 旧版或无权限 |
| `policy.terms` | string | ❌ | `"Enable access to…"` | 启用该模型的策略说明，含数据保留声明的外链 |

---

## `warning_message` / `warning_text`

仅部分模型携带，客户端应酌情向用户展示。

| 字段 | 类型 | 必填 | 说明 |
|---|---|:---:|---|
| `warning_message` | string | ❌ | 面向用户的警告文字（如计费模式变更提示） |
| `warning_text.data_retention` | string | ❌ | 第三方供应商数据保留声明，说明提示词和输出如何被供应商处理 |

---

## `capabilities` 对象

### 基础能力

| 字段 | 类型 | 必填 | 示例值 | 说明 |
|---|---|:---:|---|---|
| `capabilities.object` | string | ✅ | `"model_capabilities"` | 固定类型标记 |
| `capabilities.type` | string | ✅ | `"chat"` | 模型用途。`"chat"` = 对话；`"embeddings"` = 向量嵌入。本插件过滤掉非 `"chat"` 类型 |
| `capabilities.family` | string | ❌ | `"claude-fable-5"` | 模型家族标识，同家族共享参数规格和行为特征 |
| `capabilities.tokenizer` | string | ❌ | `"o200k_base"` | 使用的 tokenizer 名称，影响客户端 token 计数精度 |

---

### `capabilities.limits` 对象

| 字段 | 类型 | 必填 | 示例值 | 说明 |
|---|---|:---:|---|---|
| `capabilities.limits.max_context_window_tokens` | int | ❌ | `264000` | 单次请求最大上下文长度（prompt + output 之和），即通常所说的"上下文窗口" |
| `capabilities.limits.max_prompt_tokens` | int | ❌ | `200000` | 输入 prompt 的最大 token 数 |
| `capabilities.limits.max_output_tokens` | int | ❌ | `64000` | 流式模式下最大生成 token 数 |
| `capabilities.limits.max_non_streaming_output_tokens` | int | ❌ | `16000` | 非流式模式下最大生成 token 数（通常远小于流式上限） |
| `capabilities.limits.max_inputs` | int | ❌ | `512` | 单批次最大输入条数，仅 embedding 模型使用 |

---

### `capabilities.limits.vision` 对象

仅在模型支持图片输入时存在（`capabilities.supports.vision === true`）。

| 字段 | 类型 | 必填 | 示例值 | 说明 |
|---|---|:---:|---|---|
| `capabilities.limits.vision.max_prompt_image_size` | int | ❌ | `3145728` | 单张图片最大字节数（示例值 = 3 MB） |
| `capabilities.limits.vision.max_prompt_images` | int | ❌ | `1` | 单次请求最多携带图片数量 |
| `capabilities.limits.vision.supported_media_types` | string[] | ❌ | `["image/jpeg","image/png","image/webp","image/gif","application/pdf"]` | 支持的图片/文档 MIME 类型 |

---

### `capabilities.supports` 对象

| 字段 | 类型 | 必填 | 示例值 | 说明 |
|---|---|:---:|---|---|
| `capabilities.supports.streaming` | bool | ❌ | `true` | 是否支持流式输出（SSE）|
| `capabilities.supports.tool_calls` | bool | ❌ | `true` | 是否支持函数/工具调用（Function Calling）|
| `capabilities.supports.parallel_tool_calls` | bool | ❌ | `true` | 是否支持在单次响应中并行发起多个工具调用 |
| `capabilities.supports.structured_outputs` | bool | ❌ | `true` | 是否支持 JSON Schema 约束的结构化输出 |
| `capabilities.supports.vision` | bool | ❌ | `true` | 是否支持图片输入。本插件以此字段决定是否声明 `image` 输入模态。**不从模型名称推断。** |
| `capabilities.supports.reasoning_effort` | string[] | ❌ | `["low","medium","high","xhigh","max"]` | 支持的推理强度级别列表，GPT-5.x / Gemini / Kimi 系列使用。级别名称因模型而异。 |
| `capabilities.supports.adaptive_thinking` | bool | ❌ | `true` | 是否支持 Anthropic 自适应思考（Claude 系列专有）|
| `capabilities.supports.min_thinking_budget` | int | ❌ | `1024` | 思考 token 最小预算（Claude 思考模式下限）|
| `capabilities.supports.max_thinking_budget` | int | ❌ | `32000` | 思考 token 最大预算（Claude 思考模式上限）|
| `capabilities.supports.dimensions` | bool | ❌ | `true` | 是否支持指定输出向量维度，仅 embedding 模型使用 |

---

## 插件使用情况速查

| 字段 | 插件当前是否使用 | 用途 |
|---|:---:|---|
| `id` | ✅ | 模型注册标识 |
| `name` | ✅ | 展示名 |
| `supported_endpoints` | ✅ | 路由选择（`/chat/completions` vs `/responses`）|
| `capabilities.type` | ✅ | 过滤非 chat 模型 |
| `capabilities.limits.max_context_window_tokens` | ✅ | `contextWindow` |
| `capabilities.limits.max_output_tokens` | ✅ | `maxTokens` |
| `capabilities.supports.reasoning_effort` | ✅ | 推理强度选项 |
| `capabilities.supports.min/max_thinking_budget` | ✅ | Claude 思考预算 |
| `capabilities.supports.vision` | ✅ | 图片输入模态声明 |
| `capabilities.limits.vision.*` | ✅ | 图片限制参数 |
| `model_picker_enabled` | ✅ | 首要过滤条件（v0.3.10） |
| `model_picker_category` | ❌ | 未使用，可用于 picker 分组 |
| `policy.state` | ❌ | 未使用，可作为二级过滤条件 |
| `preview` | ❌ | 未使用，可用于预览标签展示 |
| `vendor` | ❌ | 未使用，可用于按供应商分组 |
| `warning_message` | ❌ | 未使用，可在模型选择时展示提示 |
| `warning_text.data_retention` | ❌ | 未使用，可在隐私说明中引用 |
| `capabilities.supports.tool_calls` | ❌ | 未使用 |
| `capabilities.supports.parallel_tool_calls` | ❌ | 未使用 |
| `capabilities.supports.structured_outputs` | ❌ | 未使用 |
| `capabilities.supports.streaming` | ❌ | 未使用（始终使用流式）|
| `capabilities.supports.adaptive_thinking` | ❌ | 未使用（通过 `min/max_thinking_budget` 推断）|
| `capabilities.family` | ❌ | 未使用 |
| `capabilities.tokenizer` | ❌ | 未使用 |
