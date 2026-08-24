# GitHub Copilot 原生视觉能力与文档理解：开发交接规格

> 本文件是本仓库视觉功能的实施权威。开始编码前必须完整阅读本文件、仓库根目录 `AGENTS.md`、`CONTEXT.md`，以及 `docs/adr/` 中相关决策。

## 0. 状态与目标基线

当前仓库状态：

```text
插件版本：@lujianjun19/dsh-llm-github-copilot 0.3.10
当前实现基线：@deepseek-ai/dsh 0.1.0-rc.6
当前自动化测试：86 项通过
当前已实现：动态视觉 catalog、用户图片 Chat/Responses 序列化、基础模型限制校验
当前未完成：最新 Harness 原生图片来源、请求图片派生、历史图片 offload、真实 Provider 全链路 smoke
```

本轮目标：

```text
目标插件版本：v0.4.0
最低 Harness 基线：0.1.1-rc.2
上游调查标签：dsh-v0.1.1-rc.2
上游调查提交：b150a551b8d465e31e418e1b2eaf5e79bbb7d28e
```

最新 Harness 参考：

- [Release notes](https://github.com/deepseek-ai/deepseek-harness/releases)
- [DeepSeek adapter 视觉说明](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/llm/llm-deepseek/README.md)
- [Attachment subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/subsystems/attachment.md)
- [`readImageRequest()` 实现](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/attachment/attachment-local/src/request-image.ts)
- [Request image offload helpers](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/llm/llm/src/content.ts)
- [Copilot 官方 Responses 工具图片转换](https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/platform/endpoint/node/responsesApi.ts#L145-L166)

---

## 1. 仓库与强制规则

- 只在本仓库根目录工作。
- Host 源码位于 `src/host/`，Client 源码位于 `src/client/`。
- 禁止直接编辑 `lib/index.js`、`lib/client.js` 或 `~/.dsh/profiles` 下的安装包。
- `lib/` 必须由 `npm run build` 生成并与源码一起提交。
- 每个源码 fragment 必须少于 450 行；新增职责使用新 fragment。
- 不修改 DeepSeek Harness core，除非用户另行明确批准。
- 不重写 Harness Composer、AttachmentRail、图片历史 renderer 或 AttachmentStore。
- Client UI 必须使用 Harness primitives/tokens，支持中英文并以英文回退；本轮不需要新增视觉 Client UI。

固定开发流程：

```bash
git status --short
# 修改 src/、tests/ 和 docs/
npm run build
npm test
npm run check
git diff --stat
git diff
```

通过后才能：

```bash
npm run deploy
```

Host 变化后重启 `dsh web`；Client 变化后硬刷新浏览器。

---

## 2. 领域边界与术语

规范术语以根目录 `CONTEXT.md` 为准：

- **Durable image**：经 Harness 准入并以不可变 Attachment 引用保存在会话历史中的图片。
- **Request image**：针对某个精确模型路由，从 Durable image 临时派生的 Provider 请求版本。
- **Image overflow policy**：Request images 超过 Provider 或本地资源限制时的处理规则。
- **Protected request image**：不能被默认 offload 的当前用户图片和最新工具图片批次。

必须保持以下边界：

```text
Harness 拥有：图片准入、持久化、历史、显示、模型能力门禁、请求图片派生
本插件拥有：Copilot catalog 映射、Copilot 路由策略、Copilot wire 序列化和错误语义
Provider 拥有：模型实际能力、单图大小、图片数量、MIME 和最终请求接受结果
```

不要把 Durable image、Request image 和 wire Data URI 混称为“附件”。

---

## 3. 已确认的最新 Harness 能力

### 3.1 Durable image 链路

最新 Harness 已提供完整链路：

```text
浏览器粘贴/拖拽 File
  → Composer / command image input
  → AttachmentStore 批量准入并持久化
  → Session 日志保存 ImageAttachmentRef
  → LLM 根据 inputModalities 做模型门禁
  → adapter 从 AttachmentStore 派生 Request image
  → Provider wire request
```

本插件不得重复实现上传、缩略图、持久化或历史恢复。

### 3.2 最新 Attachment 默认值

Harness `0.1.1-rc.2` 的本地 AttachmentStore 默认准入限制：

```text
单个源图片：20 MiB
单消息图片数：20
单消息源图片总量：200 MiB
单图像素：64,000,000
单边尺寸：8192 px
```

Provider-independent 持久化规范化默认：

```text
最长边：2048 px
编码字节：4 MiB
```

这些是 Harness 部署策略，不是 Copilot 模型限制。

### 3.3 `readImageRequest()`

最新 `AttachmentStore` 提供：

```ts
readImageRequest(ref, { maxPixels, maxBytes }, signal)
```

它负责：

- 按比例缩放且不放大小图；
- PNG、WebP、JPEG 编码选择；
- 编码质量降级；
- 像素和字节硬上限；
- 8-bit sRGB/sRGBA 校验；
- 确定性 `variantId`；
- 磁盘缓存；
- 相同变体 singleflight；
- 有界图片转换并发；
- 每个等待者独立取消。

本插件必须调用该 API，不能继续用 `readImage()` 后直接 Base64 作为主路径。

### 3.4 LLM 公共图片 helper

最新 `@deepseek-ai/dsh-llm` 导出：

```ts
contentHasImage()
offloadRequestImagesWithPolicy()
requestImageHandleText()
projectImagesForTextModel()
```

本插件应直接复用前三项。文本模型历史图片投影由 Harness runtime 负责，本插件不创建第二套投影。

### 3.5 最新原生图片来源

Harness 可以产生图片的入口包括：

- 普通 Composer 用户消息；
- `/goal`；
- `/plan`；
- 内置 `read_image`；
- MCP 工具结果；
- ACP/Code Mode 嵌套工具结果。

其中工具结果消息具有：

```text
role = user
source.kind = tool
content = [{ type: tool-result, content: [...text/image blocks] }]
```

当前插件拒绝 tool-result 图片，这是 v0.4.0 必须修复的主要缺口。

---

## 4. 本轮范围

### 4.1 必须完成

1. 将 Harness 最低基线升级到 `0.1.1-rc.2`。
2. 保留 GitHub `/models` 动态视觉能力发现。
3. 允许静态 catalog 显式声明视觉能力，但不按名称推断。
4. 使用 `readImageRequest()` 派生 Request images。
5. 支持 `error` 和 `offload-oldest` 两种 overflow policy，默认后者。
6. 保护最近用户图片，并优先保留最新工具图片批次。
7. Chat Completions 和 Responses 都支持 user 与 tool-result 图片。
8. 支持 Harness 所有原生图片来源。
9. 对图片出现次数、单图大小、MIME 和本地聚合 Base64 预算做请求前处理。
10. 完成最新 Harness 集成和真实 Copilot smoke 后才能发布 v0.4.0。

### 4.2 明确不在范围

- 修改 Harness core；
- 自定义 Composer 或通用 FileRail；
- PDF、DOCX、XLSX 直接上传聊天框；
- Provider 外部图片 URL；
- assistant 图片输出；
- system/assistant 历史图片输入；
- 插件内引入 `sharp` 或第二套图片转码管线；
- DeepSeek `/files`、file-id 缓存或配额清理；
- 根据模型名字/family 推断视觉能力；
- 文档解析代码合并进本插件。

---

## 5. GitHub 模型视觉能力事实源

GitHub `/models` 典型返回：

```json
{
  "id": "gpt-4.1",
  "capabilities": {
    "supports": {
      "vision": true
    },
    "limits": {
      "vision": {
        "max_prompt_image_size": 3145728,
        "max_prompt_images": 1,
        "supported_media_types": [
          "image/jpeg",
          "image/png",
          "image/webp",
          "image/gif"
        ]
      }
    }
  },
  "supported_endpoints": ["/chat/completions"]
}
```

自动判断规则：

```js
const supportsVision = raw?.capabilities?.supports?.vision === true
```

只有严格等于 `true` 时自动声明 `image`。不得从以下信息推断：

- 模型 id 或显示名称；
- family/vendor；
- 存在 `limits.vision`；
- 其他账号或其他时间返回的目录；
- endpoint 类型本身。

原因：模型和视觉权限会随账号、组织、地区、策略和模型生命周期变化。

---

## 6. 内部 catalog 结构

动态和静态 catalog 最终统一为：

```js
{
  id,
  name,
  description,
  contextWindow,
  maxTokens,
  endpoints,
  inputModalities: ["text", "image"],
  vision: {
    maxImageBytes,
    maxImages,
    mediaTypes,
    imagePixelBudget
  }
}
```

字段映射：

```text
max_prompt_image_size  → vision.maxImageBytes
max_prompt_images      → vision.maxImages
supported_media_types  → vision.mediaTypes
```

GitHub 当前未公布通用像素预算或聚合图片字节预算，因此：

- 动态模型默认 `imagePixelBudget = defaultImagePixelBudget`；
- 聚合 Base64 预算来自插件本地资源策略；
- 不得把这两个本地值伪装成 GitHub 返回的 Provider 限制。

字段校验：

- 大小、数量、像素必须是正安全整数；
- MIME 必须是非空字符串并去重；
- `inputModalities` 非空、无重复、仅允许 `text`/`image`；
- text-only 模型不能声明 `vision` 限制；
- 未知字段忽略；
- 未公布的 Provider 限制保持 `undefined`。

---

## 7. 配置设计

建议新增顶层设置：

```yaml
imageOverflowPolicy: offload-oldest       # offload-oldest | error
defaultImagePixelBudget: 4194304          # 2048 * 2048
maxInlineRequestImageBytes: 20971520       # 20 MiB Base64 字符载荷
inlineImageOffloadByteQuantum: 10485760    # 10 MiB
```

这些设置应进入现有 `llm-github-copilot` settings namespace，并沿用当前 last-good snapshot 行为热更新。

静态 catalog 可显式配置：

```yaml
models:
  - id: custom-vision-model
    name: Custom Vision Model
    inputModalities: [text, image]
    vision:
      maxImageBytes: 3145728
      maxImages: 1
      mediaTypes: [image/jpeg, image/png, image/webp]
      imagePixelBudget: 4194304
```

优先级：

```text
动态 /models 成功 → 使用账号实时返回
动态发现失败      → 使用显式静态 catalog
静态未声明 image  → text-only
```

不得保留“发现失败后按名称自动开启 vision”的路径。

---

## 8. Request image 投影模块

建议用新的 Host fragment 替换当前简单 resolver：

```text
src/host/04-image-request-projection.js
```

它是 Chat 和 Responses 共享的深模块，负责完整图片策略；两个 serializer 只负责 wire shape。

### 8.1 输入与输出

概念接口：

```js
prepareRequestImages({
  messages,
  model,
  attachmentStore,
  signal,
  overflowPolicy,
  defaultImagePixelBudget,
  maxInlineRequestImageBytes,
  inlineImageOffloadByteQuantum
})
```

输出至少包含：

```js
{
  messages,               // 临时投影，不修改 Durable history
  requestImages,          // Map<attachmentId, RequestImageAttachment>
  omitted,                // 数量和命中的限制，用于单条 warning
  resolve(ref),           // 返回派生版本、稳定句柄和 data URL
  protectedAttachmentIds
}
```

具体接口可以调整，但策略必须只存在于一个模块中。

### 8.2 图片出现次数与 I/O 去重

Provider `max_prompt_images` 按 wire 图片出现次数计算：

```text
同一个 attachmentId 出现两次 = 2 张 Provider 图片
```

但派生 I/O 按唯一 attachmentId 去重：

```text
同一个 attachmentId 出现两次 = 1 次 readImageRequest()
```

当前 v0.3.10 的“同 attachmentId 只计一张”测试必须改为新的正确语义。

### 8.3 Request image policy

每个模型解析：

```js
{
  maxPixels: model.vision?.imagePixelBudget ?? defaultImagePixelBudget,
  maxBytes: model.vision?.maxImageBytes ?? 4 * 1024 * 1024
}
```

默认像素预算 `2048 × 2048`，目的是保留 Harness 已规范化图片的最大细节，不套用 DeepSeek Provider 专属的 640,000 像素默认值。

### 8.4 Protected request images

每次请求按消息 `source.kind` 定位：

1. 最近一条 `source.kind === "user"` 消息中的图片受保护；
2. 当前请求中最新一条含图片的 `source.kind === "tool"` 结果批次优先保留；
3. 更旧工具图片可被更新工具图片替代；
4. 工具图片不能挤掉当前用户图片；
5. 当前用户图片与最新工具图片合计仍无法满足限制时明确失败。

不得简单以“最后一条 role=user 消息”为当前用户输入，因为工具结果本身也是 role=user。

### 8.5 两阶段 offload

默认 `offload-oldest` 使用两阶段：

#### 第一阶段：保守投影

在读取图片前，根据 Durable ref 元数据估算：

```js
conservativeBytes = Math.min(ref.bytes, requestPolicy.maxBytes)
```

将 Protected images 占用从可用预算中扣除，只对可淘汰图片调用 Harness 的 `offloadRequestImagesWithPolicy()`。实现可以用临时 sentinel/mask 保留 Protected blocks，再合并回投影；不得修改原消息对象。

目的：不读取注定会被省略的旧图片。

#### 第二阶段：精确投影

只对第一阶段保留的唯一 AttachmentRefs 并行调用：

```js
await Promise.all(refs.map(ref =>
  attachmentStore.readImageRequest(ref, policy, signal)
))
```

再根据派生版本精确字节和 Base64 长度执行第二次 offload：

```text
base64Length = ceil(bytes / 3) * 4
```

规则：

- 第一阶段省略的图片不能恢复；
- 第二阶段仍不能淘汰 Protected images；
- 当前提交自身超过数量或总预算时失败；
- byte quantum 默认 10 MiB；
- count quantum 使用 1，避免小图片数量限制产生意外大步淘汰。

### 8.6 `error` 模式

`imageOverflowPolicy: error` 时：

- 不进行历史 offload；
- 完整请求任一 Provider/本地限制超出即失败；
- 仍可调用 `readImageRequest()` 压缩单图以满足已公布的单图字节限制；
- 错误不得包含图片内容或 Data URI。

### 8.7 MIME 处理

必须使用 `RequestImageAttachment.mediaType`，不能信任消息 ref 的旧声明。

若派生后的 MIME 不在模型 `mediaTypes` 中：

- 抛出明确 `UNSUPPORTED_CONTENT`；
- 不引入插件二次转码；
- 不绕过 Request image 回退原图；
- 不修改 Harness core。

示例：

```text
GitHub Copilot model "example" does not accept derived request image type image/webp; accepted types: image/jpeg, image/png.
```

### 8.8 稳定句柄

每个 Provider 图片前调用：

```js
requestImageHandleText(version)
```

典型文本：

```text
Image sha256:<完整摘要>; request image 1280x720px.
```

不要自行维护截断摘要格式。

### 8.9 日志与安全

发生 offload 时，每个请求最多记录一条 warning：

```text
GitHub Copilot model "gpt-4.1" omitted 2 older request images to satisfy maxImages=1.
```

日志允许：

- 模型 id；
- 淘汰数量；
- 命中的限制名称和值。

日志禁止：

- OAuth/Copilot token；
- attachmentId；
- 图片名称；
- Base64；
- Data URI；
- 图片内容或用户提示文本。

---

## 9. Chat Completions 序列化

文件：`src/host/03-serialize.js`

### 9.1 普通用户消息

纯文本必须继续使用字符串：

```json
{
  "role": "user",
  "content": "hello"
}
```

图文消息保持原 block 顺序：

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "Describe this image" },
    { "type": "text", "text": "Image sha256:...; request image 1280x720px." },
    {
      "type": "image_url",
      "image_url": { "url": "data:image/png;base64,..." }
    }
  ]
}
```

要求：

- 纯文本 wire 与 v0.3.10 完全兼容；
- 图文顺序不被 `flattenText()` 改写；
- 仅图片消息合法；
- unknown/plugin blocks 不得造成图片静默丢失。

### 9.2 工具结果图片

Chat wire 中 `role: tool` 保持文本内容，图片转为后续 user 图片输入。

并行 tool calls 有协议顺序约束：所有连续 `role: tool` 结果必须先发完，不能在两个 tool 结果之间插入 user 消息。因此：

```text
assistant(tool calls A, B)
tool(A text)
tool(B text)
user(
  "Image associated with tool call A:", handle A, image A,
  "Image associated with tool call B:", handle B, image B
)
```

必须用固定文本中的 `tool_call_id` 保留精确关联。一个连续工具结果组只产生一个跟随 user 消息，但按工具分段，不能使用无归属的泛化说明。

### 9.3 仍然拒绝

- system 消息中的 image；
- assistant 消息中的 image；
- 无法关联 `toolCallId` 的工具图片。

---

## 10. Responses API 序列化

文件：`src/host/05-responses-api.js`

普通用户图片：

```json
{
  "role": "user",
  "content": [
    { "type": "input_text", "text": "Describe this image" },
    { "type": "input_text", "text": "Image sha256:...; request image 1280x720px." },
    { "type": "input_image", "image_url": "data:image/png;base64,..." }
  ]
}
```

工具图片必须采用 Copilot 官方兼容形状：

```text
function_call_output(call-1, "text result")
user:
  input_text "Image associated with tool call call-1:"
  input_text <request image handle>
  input_image <data URI>
```

原因：Responses 的 `function_call_output` 当前只支持文本 output，Copilot 官方客户端也将工具图片拆成后续 user input。

要求：

- 每个工具调用保留精确 call-id 关联；
- 多张图保持工具结果内部顺序；
- 现有 assistant output、function_call、reasoning 和 SSE translation 不变；
- system/assistant image 继续拒绝。

---

## 11. Adapter 请求入口

文件：`src/host/08-adapter.js`

请求顺序：

1. 解析本次 connection snapshot；
2. 获取 catalog 中的精确 model entry；
3. 选择 Chat 或 Responses wire format；
4. 递归检查任何 user/tool-result image；
5. 要求模型明确包含 `image` modality；
6. 动态解析 `ctx.get("attachments")`；
7. 运行共享 Request image 投影；
8. serializer 生成 Provider body；
9. `JSON.stringify()`；
10. 发起网络请求并翻译 stream。

缺少 AttachmentStore：

```text
GitHub Copilot image input requires the durable attachment service
code = UNSUPPORTED_CONTENT
```

模型不支持图片：

```text
GitHub Copilot model "<id>" does not support image input.
code = UNSUPPORTED_CONTENT
```

Text-only 请求不解析 AttachmentStore，也不承担图片转换成本。

---

## 12. 模型刷新与缓存

继续复用现有：

```text
credentials/updated
  → 清除 token exchange cache
  → 清除 catalog cache
  → registration.replace([PROVIDER])
  → llm/adapters-updated
  → 浏览器重新读取 session.models
```

新增设置变化必须在下一次请求生效：

- overflow policy；
- 默认像素预算；
- Base64 总预算；
- byte quantum；
- 静态 catalog。

不得创建第二套模型 catalog cache。

`readImageRequest()` 的变体缓存由 AttachmentStore 管理；插件只保留每请求 Map，不创建跨请求图片缓存。

---

## 13. 错误语义

错误信息必须包含足够诊断信息，但不含图片内容。

### 当前用户图片数量超限

```text
GitHub Copilot model "gpt-4.1" accepts at most 1 image per request; the current user message contains 2 protected images.
```

### 当前用户图片与最新工具图片冲突

```text
GitHub Copilot model "gpt-4.1" cannot retain both the current user image and the latest tool-result image within its 1-image request limit.
```

### 本地 Base64 总预算

```text
GitHub Copilot image input for model "example" exceeds the configured 20971520-byte inline request budget after protected images are retained.
```

### MIME

```text
GitHub Copilot model "example" does not accept derived request image type image/webp.
```

### Strict 模式

```text
GitHub Copilot model "example" image request exceeds maxImages=1 while imageOverflowPolicy is "error".
```

错误 code 使用 `UNSUPPORTED_CONTENT`，除非底层 AttachmentStore 已返回更具体且稳定的 attachment error。

---

## 14. 测试计划

### 14.1 Catalog 测试

覆盖：

1. `supports.vision=true` → `[text, image]`；
2. false/缺失 → `[text]`；
3. 仅有 `limits.vision` 不启用图片；
4. size/count/MIME 映射；
5. 非法限制忽略；
6. 不按名称/family 推断；
7. 静态显式 image 配置；
8. 静态 text-only 禁止 vision limits；
9. 动态成功优先于静态 fallback。

### 14.2 Request image 投影测试

覆盖：

- 调用 `readImageRequest()` 而非 `readImage()`；
- max bytes/pixels policy；
- AbortSignal；
- Promise.all 并发准备；
- 相同 attachmentId 只派生一次；
- 相同 attachmentId 出现两次按两张 Provider 图片计数；
- 派生 mediaType/bytes 为权威值；
- unsupported derived MIME；
- 第一阶段省略图片不读取；
- 第二阶段按 Base64 精确长度；
- 第一阶段省略后不恢复；
- 不修改原始 messages/blocks。

### 14.3 Overflow 测试

覆盖：

- `error` 模式完整失败；
- 默认 offload oldest；
- 最近人类消息图片受保护；
- 当前用户消息自身超限；
- 最新工具图片替代旧工具图片；
- 工具图片不能替代当前用户图片；
- 当前用户 + 最新工具不可共存时失败；
- count quantum = 1；
- byte quantum = 10 MiB；
- 每请求最多一条安全 warning。

### 14.4 Chat payload 测试

覆盖：

- 纯文本 wire 完全不变；
- text + image；
- image + text + image 顺序；
- image-only；
- request image handle；
- 单工具图片；
- 并行工具结果先连续 tool，再分段 user images；
- 嵌套 tool-result 图片；
- system/assistant image 拒绝。

### 14.5 Responses payload 测试

覆盖：

- `input_text` + `input_image`；
- `function_call_output` 只含文本；
- 后续 user 图片包含 call-id marker；
- 多工具关联；
- Responses-only visual model；
- reasoning/tools 字段不变；
- SSE translator 测试不回归。

### 14.6 最新 Harness 集成测试

在 `0.1.1-rc.2` 环境验证：

1. Composer paste/drop；
2. AttachmentRail；
3. 历史刷新；
4. `/goal` 携带图片；
5. `/plan` 携带图片；
6. `read_image` 读取工作区图片；
7. MCP 图片结果；
8. ACP/Code Mode 图片；
9. text-only 路由的历史图片投影；
10. credentials 更新后的模型能力刷新。

### 14.7 真实 Copilot smoke

发布前必须完成：

- Chat 用户图片；
- Chat `read_image` 工具图片；
- Responses 用户图片；
- Responses 工具图片；
- 历史 offload；
- `/goal` 或 `/plan` 图片；
- 页面刷新后历史图片恢复。

测试图片应小而确定，包含可识别文字：

```text
VISION_TEST_42
```

---

## 15. 实施顺序

建议多个 Conventional Commit，一次发布 v0.4.0：

### Commit 1

```text
chore: target DeepSeek Harness 0.1.1-rc.2
```

- peer dependencies；
- lockfile；
- 构建/测试环境；
- 校验新公共 API 可用。

### Commit 2

```text
feat: derive Copilot request images through Harness
```

- 新 Request image 投影模块；
- `readImageRequest()`；
- 稳定句柄；
- MIME 和单图 policy。

### Commit 3

```text
feat: offload overflowing historical request images
```

- settings；
- strict/offload；
- Protected images；
- 两阶段预算；
- warning。

### Commit 4

```text
feat: support durable tool-result images
```

- Chat；
- Responses；
- call-id 关联；
- Harness 原生图片来源。

### Commit 5

```text
test: cover native Harness image sources
```

- 单元；
- 集成 fixtures；
- 回归。

### Commit 6

```text
docs: update vision integration guidance
```

- README/README.zh；
- CHANGELOG；
- 本文件最终状态；
- ADR 引用。

不要发布中间的半完成视觉版本。

---

## 16. v0.4.0 最终验收

必须同时满足：

- Harness 最低基线为 `0.1.1-rc.2`；
- 动态视觉 catalog 正确；
- 静态视觉 fallback 仅显式开启；
- 用户和 tool-result Durable images 均能成为 Request images；
- Chat 和 Responses 均通过；
- Request images 使用 Harness 派生与缓存；
- overflow 默认淘汰旧图片但保护当前用户意图；
- strict 模式可用；
- 本地 Base64 资源预算可配置；
- 历史图片不因临时 offload 被删除；
- OAuth、reasoning、tools、stream translation 无回归；
- 最新 Harness 集成测试通过；
- 真实 Copilot smoke 全部通过；
- Host/浏览器无未处理异常。

发布流程：

```bash
npm run build
npm test
npm run check
git diff --stat
git diff
npm run deploy
# 重启 dsh web，硬刷新浏览器，执行真实 smoke
npm run pack:local
```

更新 `CHANGELOG.md` 后使用 minor release：

```bash
npm version minor
```

任何门禁失败都不得声称功能完成或发布 v0.4.0。

---

# Part B：部分文档理解设计

## 17. 文档能力为什么不放进 Copilot adapter

文档理解与视觉 adapter 是两个独立工作流。

当前 Harness 原生 prompt 图片路径不等于通用文件上传协议。PDF、DOCX、XLSX 不应伪装成 image，也不应通过 Copilot adapter 私有上传。

文档能力应由独立工具插件提供：

```text
read_document(path/range/query)
  → 通过 Harness fs seam 安全读取工作区文件
  → 解析为受限结构化文本
  → 返回任意 LLM 可消费的 Markdown
```

这样它：

- 不依赖 Copilot OAuth；
- 可服务任意 Provider；
- 不修改 Composer；
- 不绕过 workspace/sandbox；
- 不污染 LLM adapter 职责。

旧交接记录显示该独立项目已在 `dsh-tool-document` 仓库完成 v0.1.0；本仓库本轮不修改该项目。

---

## 18. 文档工具范围

支持工作区路径中的：

- 有文本层的 PDF；
- DOCX；
- XLSX；
- CSV；
- TXT / Markdown / JSON。

第一版不支持：

- 聊天输入框直接上传普通文档；
- 扫描 PDF OCR；
- `.doc` / `.xls`；
- PPT/PPTX；
- 加密/密码文档；
- 宏、公式或嵌入脚本执行。

---

## 19. `read_document` 工具接口

建议输入：

```ts
{
  path: string
  pages?: string
  sheets?: string[]
  range?: string
  query?: string
  maxChars?: number
}
```

示例：

```json
{
  "path": "reports/quarterly.pdf",
  "pages": "1-10",
  "query": "revenue growth",
  "maxChars": 30000
}
```

```json
{
  "path": "finance.xlsx",
  "sheets": ["Q1", "Q2"],
  "range": "A1:H200"
}
```

返回 Markdown，包含：

- 文件名和 MIME；
- 实际读取范围；
- 页码/Sheet/单元格范围；
- 是否截断；
- 提取内容；
- 后续调用建议范围。

---

## 20. 文档文件访问安全

必须通过 Harness `ctx.fs`：

```js
const target = await ctx.fs.resolve(...)
const info = await ctx.fs.stat(target, signal)
const data = await ctx.fs.readBytes(target, signal, byteLimit)
```

不得直接使用 Node `fs.readFile(path)` 绕过：

- workspace confinement；
- sandbox policy；
- symlink/path resolution；
- approval policy；
- cancellation；
- byte limit。

---

## 21. 文档格式策略

### TXT / Markdown / JSON

- UTF-8 严格解码；
- JSON 只格式化、不执行；
- 控制最大字符数。

### CSV

- 识别常见分隔符或允许配置；
- 输出 Markdown table；
- 限制行、列和单元格数；
- 公式样式文本视为普通字符串。

### PDF

推荐 `pdfjs-dist`：

- 仅提取文本层；
- 保留页码；
- 支持页码范围；
- 页面间有明确边界；
- 扫描 PDF 和加密 PDF 返回明确错误。

### DOCX

推荐 `mammoth`：

- 段落、标题、列表；
- 基础表格；
- 链接文本；
- 忽略宏、脚本和 OLE；
- 限制 ZIP 膨胀大小和 entry 数。

### XLSX

推荐 `exceljs`：

- Sheet 名称；
- 显示值；
- 公式文本和缓存值；
- 指定 range；
- 不执行公式、外部连接或宏；
- 限制 Sheet、行、列和总单元格。

---

## 22. 文档资源限制

建议默认：

```text
单文件最大：20 MiB
PDF 最大页数：200
DOCX 最大解包：100 MiB
XLSX 最大 Sheet：20
单 Sheet 最大行：10,000
单 Sheet 最大列：200
总单元格最大：200,000
单次工具输出：50,000 字符
```

必须防御：

- ZIP bomb；
- 超大 PDF object graph；
- 恶意共享字符串表；
- 宏和嵌入对象；
- 公式注入；
- 极大 worksheet dimension；
- NUL 文件名和异常 Unicode；
- 忽略取消信号。

超过输出上限时应返回截断标记和下一次建议范围，不得静默丢失。

---

## 23. 文档工具测试

Fixtures：

- UTF-8 TXT；
- 多页文本 PDF；
- 无文本层 PDF；
- 段落和表格 DOCX；
- 两个 Sheet、公式和合并单元格 XLSX；
- CSV；
- 加密/损坏文件；
- ZIP bomb 模拟结构。

安全测试：

- workspace 外路径拒绝；
- symlink escape；
- byte cap；
- abort；
- 解包限制；
- 行列/页数限制；
- 不执行宏或公式。

集成测试：

- Agent 可调用 `read_document`；
- 结果含来源范围；
- 大文档返回截断标记；
- 任意 LLM Provider 可消费；
- 不依赖 Copilot OAuth。

---

## 24. 真正的聊天框通用文件上传

如果未来要求像图片一样将 PDF/DOCX/XLSX 拖入聊天框，需要另行批准 Harness core 范围，包括：

1. `FileAttachmentRef`；
2. `FileBlock`；
3. PromptContentPart `file` wire；
4. 通用 attachment store；
5. FileRail 与历史卡片；
6. session authorization/read；
7. fork/export/persistence；
8. adapter 或 extraction service。

在没有明确批准前，不实现 DOM paste hack、私有 Composer 或绕过 session prompt 的自定义上传。
