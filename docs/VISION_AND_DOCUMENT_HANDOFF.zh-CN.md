# GitHub Copilot 视觉能力与文档理解：开发交接规格

> 面向后续编码模型的自包含实施说明。开始编码前必须完整阅读本文件和仓库根目录 `AGENTS.md`。

## 0. 仓库与强制规则

- 源码仓库：`/home/ljjun/repos/dsh-llm-github-copilot`
- DSH 安装目标：`~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-llm-github-copilot`
- 当前基线：`v0.2.0`
- 当前 DSH API 目标：`@deepseek-ai/dsh` `0.1.0-rc.6`
- 禁止直接修改 `lib/`；它由 `npm run build` 生成。
- 禁止直接修改 DSH 安装目录。
- 禁止修改 DeepSeek Harness 核心代码，除非用户另行明确批准。
- 每个源码分片必须小于 450 行；新增职责应新增分片，不要继续扩大单文件。
- UI 必须使用 Harness primitives/tokens；语言随 Harness locale，支持中文和英文，缺省回退英文。

每次开发的固定流程：

```bash
cd /home/ljjun/repos/dsh-llm-github-copilot
git status --short
# 修改 src/ 和 tests/
npm run build
npm test
npm run check
git diff --stat
git diff
# 提交后
npm run deploy
```

Host 代码变化后必须重启 `dsh web`；Client 变化后需要硬刷新浏览器。

---

## 1. 本次开发目标

本设计包含两个相互独立的工作流。

### 工作流 A：GitHub Copilot 视觉模型支持（本仓库实施）

完成后：

1. 从 GitHub `/models` 动态识别 `capabilities.supports.vision === true` 的模型。
2. 向 DSH 声明这些模型支持 `inputModalities: ['text', 'image']`。
3. 复用 DSH 已有的图片粘贴、拖拽、缩略图、持久化和历史展示。
4. 从 `ctx.attachments` 读取持久化图片。
5. 同时支持 Copilot `/chat/completions` 和 `/responses` 图片请求。
6. 根据模型返回的图片数量、大小、MIME 限制进行请求前校验。
7. 不通过模型名称猜测视觉能力；账号实际 `/models` 返回值是唯一事实源。

### 工作流 B：部分文档理解（建议独立工具插件实施）

支持工作区路径中的：

- PDF（仅有文本层的 PDF）
- DOCX
- XLSX
- CSV
- TXT / Markdown / JSON

文档能力通过 `read_document` 工具把文件解析为受限、结构化文本，再交给任意 LLM。它不应耦合在 Copilot adapter 中。

### 明确不在本次范围

- 聊天输入框直接上传 PDF、DOCX、XLSX。
- 新增通用文件 AttachmentRail。
- 扫描 PDF OCR。
- `.doc` / `.xls` 旧二进制格式。
- PPTX。
- 加密/密码文档。
- 执行 Office 宏、公式或嵌入脚本。
- 自动修改 DeepSeek Harness 核心 attachment 协议。
- 第一版支持 Chat Completions 的 tool-result 图片。

---

## 2. 已确认的 DSH 现状

当前安装的 DSH rc.6 已经包含完整的图片链路：

```text
浏览器粘贴/拖拽 File
  → ui-conversation InputBar
  → AttachmentRail 缩略图
  → session.prompt(Base64 image part)
  → ApiProxy 根据 inputModalities 做模型门禁
  → attachment-local 校验并持久化
  → Session 日志保存 ImageAttachmentRef
  → LLM adapter 读取 AttachmentStore
  → Provider wire request
```

当前运行环境已确认包含：

```text
@deepseek-ai/dsh-attachment              0.1.0-rc.6
@deepseek-ai/dsh-attachment-local        0.1.0-rc.6
@deepseek-ai/dsh-client-ui-attachment    0.1.0-rc.6
@deepseek-ai/dsh-client-ui-conversation  0.1.0-rc.6
```

默认图片限制：

```json
{
  "maxImageBytes": 5242880,
  "maxImagesPerMessage": 20,
  "maxMessageImageBytes": 104857600,
  "maxImagePixels": 40000000,
  "mediaTypes": ["image/png", "image/jpeg", "image/webp", "image/gif"]
}
```

DSH Host 已有以下门禁：

- 发送图片时调用 `ctx.llm.resolveModelInfo()`。
- 如果 `inputModalities` 明确不包含 `image`，返回 `MODEL_DOES_NOT_SUPPORT_IMAGES`。
- 会话历史已有图片时，禁止切换到明确只支持文本的模型。

因此不要重写浏览器图片上传 UI，也不要重复实现图片存储。

---

## 3. 当前插件为什么不支持图片

当前源码中的阻塞点：

1. `src/host/08-adapter.js` 的 `modelInfo()` 固定返回：

   ```js
   inputModalities: ["text"]
   ```

2. `src/host/03-serialize.js` 的 `assertTextOnly()` 主动拒绝图片。
3. `src/host/05-responses-api.js` 只输出 `input_text`。
4. adapter 没有读取 `ctx.attachments`。
5. `src/host/09-model-discovery.js` 丢弃了 GitHub 返回的视觉能力和视觉限制。

视觉支持的核心工作应集中在这些分片，避免无关改动 OAuth、Settings 和 Client UI。

---

## 4. GitHub 模型视觉能力事实源

GitHub `/models` 的典型结构：

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

保守判断规则：

```js
const supportsVision = raw?.capabilities?.supports?.vision === true
```

只有明确为 `true` 时声明 `image`。不要根据下列信息推断：

- 模型名称；
- 模型 family；
- 存在 `limits.vision` 但 `supports.vision` 不明确；
- 其他账号曾经返回的能力。

原因：Copilot 模型和视觉权限会因账号、组织、地区和策略不同。

---

## 5. 建议的内部模型结构

在 `src/host/09-model-discovery.js` 中给 catalog entry 增加：

```js
{
  id,
  name,
  contextWindow,
  maxTokens,
  endpoints,
  inputModalities: ["text", "image"],
  vision: {
    maxImageBytes,
    maxImages,
    mediaTypes
  }
}
```

非视觉模型：

```js
inputModalities: ["text"]
```

视觉限制映射：

```text
max_prompt_image_size → vision.maxImageBytes
max_prompt_images     → vision.maxImages
supported_media_types → vision.mediaTypes
```

必须过滤非法值：

- 大小/数量必须是正整数；
- MIME 必须是非空字符串；
- 重复 MIME 去重；
- 未知字段忽略。

如果模型支持视觉但没有返回某项限制，则该项保持 `undefined`，由 DSH 全局 attachment 限制兜底。

---

## 6. 修改 `modelInfo()` 和 `resolveModel()`

文件：`src/host/08-adapter.js`

当前固定文本能力必须改为：

```js
inputModalities: model.inputModalities ?? ["text"]
```

`listModels()` 和 `resolveModel()` 必须返回一致的能力，不能一个声明图片、另一个仍然返回文本。

验收断言：

```js
await ctx.llm.listModels(PROVIDER)
await ctx.llm.resolveModelInfo(PROVIDER, modelId)
```

对同一个视觉模型都应得到：

```json
["text", "image"]
```

静态 `settings.yaml` model 配置如果没有明确的 `inputModalities`，必须保守视为 `['text']`。不要为静态模型按名称自动启用视觉。

可选增强：在 `src/host/02-schema.js` 的静态模型 schema 中增加：

```js
inputModalities: z.array(z.union([z.const("text"), z.const("image")]))
```

但第一版可以只支持动态 `/models` 视觉能力。

---

## 7. AttachmentStore 接入设计

在 `src/host/12-apply.js` 创建 adapter 时增加：

```js
resolveAttachments: () => ctx.get("attachments")
```

不要在插件启动时强制要求 attachment service。它应在真正发送图片时动态解析，和 `llm-pi-ai` 的行为一致。

请求中含图片时：

```js
const containsImage = options.messages.some(message =>
  contentHasImage(message.content)
)
```

门禁顺序：

1. 当前 catalog model 必须存在。
2. `inputModalities` 必须包含 `image`。
3. `ctx.get('attachments')` 必须存在。
4. 校验图片数量。
5. 读取每个持久化图片。
6. 校验实际 MIME 和字节大小。
7. 生成 Provider wire payload。

缺少 attachment service 时：

```js
throw new LlmError(
  "GitHub Copilot image input requires the durable attachment service",
  "UNSUPPORTED_CONTENT"
)
```

---

## 8. 请求级图片解析器

建议新增源文件：

```text
src/host/04-attachment-resolver.js
```

插入后重排编号，保持构建顺序明确。

职责：

```js
createImageResolver(attachmentStore, model, signal)
```

内部使用：

```js
Map<attachmentId, Promise<ResolvedImage>>
```

避免同一附件在一个请求中重复读取和 Base64 编码。

输出：

```js
{
  ref,
  bytes,
  mediaType,
  dataUrl
}
```

其中：

```js
dataUrl = `data:${mediaType};base64,${Buffer.from(data).toString("base64")}`
```

必须：

- 把 request AbortSignal 传给 `attachments.readImage(ref, signal)`；
- 使用存储层返回的真实 `stored.ref.mediaType`；
- 不信任消息中的 MIME 声明；
- 不把 token、图片内容或完整 data URL 写入日志；
- 同一 attachmentId 只调用一次 `readImage()`。

---

## 9. Chat Completions 序列化

文件：`src/host/03-serialize.js`

### 纯文本兼容性

纯文本消息必须继续保持当前字符串形状：

```json
{
  "role": "user",
  "content": "hello"
}
```

不要把所有文本请求都改成 content array，以免改变 Provider 缓存和兼容行为。

### 带图片的用户消息

按原始 block 顺序生成：

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "Describe this image" },
    {
      "type": "image_url",
      "image_url": {
        "url": "data:image/png;base64,..."
      }
    }
  ]
}
```

要求：

- 图片和文本顺序不能被 `flattenText()` 改写；
- 仅有图片、没有文本时也合法；
- `system` 和 `assistant` 历史中的 image 第一版明确拒绝；
- 第一版 Chat Completions `tool-result` image 明确拒绝，不要静默删除。

推荐函数：

```js
async function serializeChatUserContent(blocks, imageResolver)
async function serializeMessages(messages, imageResolver)
async function serializeRequest(options, wire, imageResolver)
```

由于读取附件是异步的，序列化函数需要变为 async，adapter request 中必须 `await`。

---

## 10. Responses API 序列化

文件：`src/host/05-responses-api.js`

用户图片格式：

```json
{
  "role": "user",
  "content": [
    { "type": "input_text", "text": "Describe this image" },
    {
      "type": "input_image",
      "image_url": "data:image/png;base64,..."
    }
  ]
}
```

推荐函数：

```js
async function serializeResponsesMessages(messages, imageResolver)
async function serializeResponsesRequest(options, wire, imageResolver)
```

第一版范围：

- 支持 user message image；
- 拒绝 system/assistant image；
- 暂不实现 tool-result image；
- 保留现有 tool call、reasoning 和 stream translation 行为不变。

不能因为加入图片而修改 Responses SSE 解析代码。

---

## 11. 模型级视觉限制

对整个请求历史中的图片执行：

### 数量

```js
if (vision.maxImages !== undefined && imageCount > vision.maxImages) {
  throw new LlmError(..., "UNSUPPORTED_CONTENT")
}
```

这里的数量应统计本次发送给 Provider 的完整 request history，不只统计最新消息。

### 单图大小

```js
stored.data.byteLength <= vision.maxImageBytes
```

### MIME

```js
vision.mediaTypes.includes(stored.ref.mediaType)
```

错误信息必须包含：

- 模型 id；
- 当前值；
- Provider 限制；
- 不包含 Base64 数据。

示例：

```text
GitHub Copilot model "gpt-4.1" accepts at most 1 image per request; this request contains 2.
```

```text
GitHub Copilot model "claude-sonnet-4.6" does not accept image/gif.
```

### 已知 UX 限制

DSH composer 只知道全局 attachment 限制，不知道每个模型的 Copilot 限制。因此图片可能先进入缩略图列表，在 adapter 发送前才因 3 MiB/数量/MIME 限制失败。

不要通过 DOM hack 修改 composer。第一版记录并接受该限制。

---

## 12. 模型刷新与缓存

现有插件已监听：

```text
credentials/updated
```

并通过：

```js
registration.replace([PROVIDER])
```

发出：

```text
llm/adapters-updated
```

视觉能力来自 catalog entry，因此登录、退出、凭据变化后必须和模型列表一起刷新。

新增视觉字段后要确认：

- `catalogCache` 清除；
- `listModels()` 返回新 modalities；
- 已打开浏览器自动重新请求 `session.models`；
- 不需要页面刷新。

不要创建第二套模型缓存。

---

## 13. 视觉能力测试清单

建议新增：

```text
tests/vision-catalog.test.mjs
tests/vision-chat-serialize.test.mjs
tests/vision-responses-serialize.test.mjs
tests/vision-adapter.test.mjs
```

### Catalog 测试

覆盖：

1. `supports.vision=true` → `['text', 'image']`。
2. `supports.vision=false` → `['text']`。
3. `supports.vision` 缺失，即使有 `limits.vision` 也只声明文本。
4. 视觉大小、数量、MIME 正确映射。
5. 非法限制被忽略。
6. 不按模型名字推断能力。

### Chat payload 测试

覆盖：

- 纯文本 wire 与修改前完全一致；
- 文本 + PNG；
- 图片 + 文本 + 图片的顺序；
- 仅图片；
- system/assistant image 拒绝；
- tool-result image 拒绝。

### Responses payload 测试

覆盖：

- `input_text`；
- `input_image` data URI；
- Responses-only visual model；
- 现有 reasoning/tools 字段保持不变。

### AttachmentResolver 测试

覆盖：

- 同一 attachment 只读取一次；
- AbortSignal 传递；
- 使用存储层真实 MIME；
- 缺少 attachment service；
- 数量、大小、MIME 超限。

### 浏览器测试

1. 选择视觉 Copilot 模型；
2. textarea 粘贴 PNG；
3. AttachmentRail 出现；
4. 发送成功；
5. 刷新后历史图片恢复；
6. 尝试切换文本模型被 Host 拒绝；
7. 浏览器 console 无 error。

### 真实 Provider 冒烟测试

使用小于 100 KiB 的确定性图片，图片内包含文字：

```text
VISION_TEST_42
```

分别测试：

- 一个 `/chat/completions` 视觉模型；
- 一个 `/responses` 视觉模型。

模型回答必须识别 `VISION_TEST_42`。

---

# Part B：部分文档理解设计

## 14. 为什么不放进 Copilot LLM adapter

当前 DSH browser prompt wire 只有：

```ts
type PromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType; data; name? }
```

`dsh-client-ui-attachment` 也明确只实现图片。PDF、DOCX、XLSX 没有：

- 通用 file block；
- 输入框文件卡片；
- Host 文件上传协议；
- 通用文件持久化引用；
- 历史文件 renderer。

因此不要在 Copilot adapter 中伪造聊天框文件上传，也不要替换整个 Harness Composer。

文档理解应作为独立工具插件，使所有模型都能使用，而不是只服务 Copilot。

---

## 15. 文档插件建议位置

建议创建独立仓库：

```text
/home/ljjun/repos/dsh-tool-document
```

建议 package：

```text
@deepseek-ai/dsh-tool-document
```

它应挂载到 Agent preset，而不是 Host 全局层。

初始结构：

```text
src/
├── index.ts
├── tool.ts
├── resolve-input.ts
├── limits.ts
├── extractors/
│   ├── text.ts
│   ├── pdf.ts
│   ├── docx.ts
│   ├── xlsx.ts
│   └── csv.ts
├── render/
│   ├── markdown.ts
│   └── truncation.ts
└── errors.ts
```

不要把文档解析代码放入当前 Copilot adapter 仓库，除非用户明确要求合并为 monorepo。

---

## 16. `read_document` 工具接口

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

返回 Markdown 文本，必须包含：

- 文件名和 MIME；
- 实际读取范围；
- 页码/Sheet/单元格范围；
- 是否截断；
- 提取内容；
- 可供后续调用使用的范围提示。

---

## 17. 文件访问安全

必须通过 DSH `ctx.fs`：

```js
const target = await ctx.fs.resolve(...)
const info = await ctx.fs.stat(target, signal)
const data = await ctx.fs.readBytes(target, signal, byteLimit)
```

不要直接使用 Node `fs.readFile(path)` 绕过：

- workspace confinement；
- sandbox policy；
- symlink/path resolution；
- approval policy；
- cancellation；
- byte limit。

文档工具必须遵守当前 session 的 workspace 和 sandbox policy，参考 DSH `tool-fs/read-image.ts` 的 resolve/read 模式。

---

## 18. 支持格式和解析策略

### TXT / Markdown / JSON

- UTF-8 严格解码；
- JSON 可格式化，但不能执行；
- 控制最大字符数。

### CSV

- 自动识别常见分隔符或允许配置；
- 输出 Markdown table；
- 限制行、列、单元格数量；
- 公式样式文本视为普通字符串。

### PDF

推荐 `pdfjs-dist`：

- 只提取文本层；
- 保留页码；
- 支持页码范围；
- 页面间加入明确边界；
- 第一版不做 OCR；
- 加密 PDF 返回明确错误。

### DOCX

推荐 `mammoth`：

- 段落、标题、列表；
- 基础表格；
- 链接文本；
- 忽略宏、脚本、嵌入 OLE；
- ZIP 解包必须限制膨胀大小和 entry 数量。

### XLSX

推荐 `exceljs`：

- Sheet 名称；
- 显示值；
- 公式文本和缓存值；
- 指定 range；
- Markdown/CSV 输出；
- 禁止执行公式、外部连接、宏；
- 限制 Sheet、行、列和单元格总量。

### 不支持

第一版明确拒绝：

```text
.doc .xls .ppt .pptx encrypted PDF scanned-only PDF
```

错误必须说明可行替代方案，例如转换为 DOCX/XLSX 或对扫描 PDF 先 OCR。

---

## 19. 文档资源限制

建议默认值：

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
- 无限/极大 worksheet dimension；
- NUL 文件名和异常 Unicode；
- 取消信号被忽略。

超过输出上限时必须截断并返回下一次建议范围，而不是静默丢失。

---

## 20. 文档工具测试

### 单元测试 fixtures

准备最小确定性 fixtures：

- UTF-8 TXT；
- 多页文本 PDF；
- 无文本层 PDF；
- 含段落和表格的 DOCX；
- 两个 Sheet、公式和合并单元格的 XLSX；
- CSV；
- 加密/损坏文件；
- ZIP bomb 模拟结构。

### 安全测试

- workspace 外路径拒绝；
- symlink escape 拒绝；
- byte cap；
- abort；
- 解包限制；
- 行列/页数限制；
- 不执行宏或公式。

### 工具集成测试

- Agent 能调用 `read_document`；
- 结果包含来源范围；
- 大文档返回截断标记；
- 任意 LLM provider 都能消费结果；
- 不依赖 Copilot OAuth。

---

## 21. 真正的聊天框文件上传（后续、需用户批准）

如果用户以后要求像图片一样把 PDF/DOCX/XLSX 拖入聊天框，需要修改 DSH 核心：

1. `FileAttachmentRef`；
2. `FileBlock`；
3. PromptContentPart `file` wire；
4. 通用 attachment store；
5. FileRail 和历史文件卡片；
6. session authorization/read；
7. fork/export/persistence；
8. adapter 或 extraction service。

在没有明确批准前，不要实现 DOM paste hack、私有 composer 或绕过 session.prompt 的自定义上传。

---

## 22. 推荐实施顺序

### ✅ PR/Commit 1：视觉 catalog（已完成 v0.3.0）

- 解析 `supports.vision` 和 limits；
- `modelInfo/resolveModel` modalities；
- catalog 单元测试（12 项）。

### ✅ PR/Commit 2：AttachmentResolver（已完成 v0.3.0）

- 动态 attachment service；
- request cache（按 attachmentId 去重）；
- MIME/size/count 校验；
- 单元测试（15 项）。

### ✅ PR/Commit 3：Chat Completions 图片（已完成 v0.3.0）

- async serializer；
- user image content（image_url 数组，纯文本保持 string 兼容）；
- 拒绝 system/assistant/tool-result 图片；
- 单元测试（11 项）。

### ✅ PR/Commit 4：Responses 图片（已完成 v0.3.0）

- `input_image`；
- Responses-only model 测试（9 项）；
- 保持现有 stream translator 不变。

### ⬜ PR/Commit 5：DSH 集成和浏览器测试（待手动验证）

- paste/drop；
- rail；
- Host model gate；
- history reload；
- model switch refusal。

### ⬜ PR/Commit 6：真实 Copilot smoke（需要真实账号）

- chat visual model；
- responses visual model；
- 小图片文字识别。

### ✅ 独立项目：文档工具（已完成 v0.1.0，见 /home/ljjun/repos/dsh-tool-document）

已完成并提交，不要和 adapter 改动混在一个提交中。

---

## 23. 最终验收标准

### 视觉

- `/models` 明确支持 vision 的模型声明 `['text', 'image']`。
- 其他模型明确声明 `['text']`。
- 用户能粘贴/拖拽图片并在 rail 中看到。
- Chat 和 Responses 两种视觉请求成功。
- 模型限制有明确错误。
- 历史图片刷新后仍显示。
- 有图片历史时不能切换文本模型。
- OAuth 登录/退出后模型和能力自动刷新。
- 浏览器和 Host 无未处理异常。

### 文档工具

- 能读取 PDF 文本层、DOCX、XLSX、CSV、文本文件。
- 使用 `ctx.fs` 并遵守 sandbox。
- 有严格资源限制和截断说明。
- 不执行宏、公式或外部对象。
- 与 Copilot OAuth 解耦，可供任意模型使用。
- 不伪装成聊天框原生文件上传。

---

## 24. 开发完成后的发布要求

1. 更新 `CHANGELOG.md`。
2. 视觉能力属于 minor release：

   ```bash
   npm version minor
   ```

3. 完整检查：

   ```bash
   npm run check
   ```

4. Git commit/tag 后部署：

   ```bash
   npm run deploy
   ```

5. 重启：

   ```bash
   dsh web
   ```

6. 浏览器硬刷新并完成真实 smoke。
7. 生成 tgz：

   ```bash
   npm run pack:local
   ```

任何一项测试失败，都不得声称功能完成或发布新版本。
