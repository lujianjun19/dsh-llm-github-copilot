import z from "@deepseek-ai/schemastery";
import { CONTEXT_WINDOW_EXCEEDED_CODE, CallId, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE, RetryPolicySchema, assertUsableApiKey, attributionHeaders, contentHasImage, isContextWindowExceededError, isQuotaExceededError, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { deepEqualJson, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { EventSourceParserStream } from "eventsource-parser/stream";

//#region constants
/** Plugin identity for the loader and its owned settings namespace. */
const name = "llm-github-copilot";
const inject = ["llm"];
const NS = settingsNamespace("llm-github-copilot");

/** The single provider route this plugin owns. Suffixed to avoid pi-ai's dormant `github-copilot` catalog route. */
const PROVIDER = "github-copilot-official";
const DISPLAY_NAME = "GitHub Copilot";

/** Credential reference holding the long-lived GitHub OAuth token from the device flow. */
const DEFAULT_OAUTH_TOKEN_ENV = "GITHUB_COPILOT_OAUTH_TOKEN";

/** Default Copilot API host; the token exchange advertises the account-specific one when it differs. */
const DEFAULT_BASE_URL = "https://api.githubcopilot.com";

/** GitHub OAuth device-flow endpoints (github.com). */
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const VERIFICATION_URI = "https://github.com/login/device";

/** Endpoint that exchanges a GitHub token for a short-lived Copilot API token. */
const TOKEN_EXCHANGE_URL = "https://api.github.com/copilot_internal/v2/token";

/** VS Code's public GitHub App client id — produces ghu_* tokens that can be exchanged. */
const OAUTH_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const OAUTH_SCOPE = "read:user";

/** Copilot integrator identity selecting the broadest model allowlist. */
const INTEGRATION_ID = "vscode-chat";
const EDITOR_VERSION = "vscode/1.107.0";
const EDITOR_PLUGIN_VERSION = "copilot-chat/0.35.0";
const EXCHANGE_USER_AGENT = "GitHubCopilotChat/0.35.0";

/** Defaults for models the endpoint does not size. */
const DEFAULT_CONTEXT_WINDOW = 262144;
const DEFAULT_MAX_TOKENS = 32768;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;

/** Refresh the short-lived Copilot token this long before it expires. */
const TOKEN_REFRESH_MARGIN_MS = 120000;

/** How long a discovered model catalog is reused before re-interrogating the endpoint. */
const CATALOG_TTL_MS = 300000;

/** Conservative fallback catalog used only when discovery and configuration name no models. */
const DEFAULT_MODELS = [
  { id: "gpt-4o", name: "GPT-4o" },
  { id: "gpt-4o-mini", name: "GPT-4o mini" },
  { id: "gpt-5-mini", name: "GPT-5 mini" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", endpoints: ["/responses"] },
  { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
  { id: "claude-opus-4.5", name: "Claude Opus 4.5" },
  { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
  { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" }
];

/** Display names for reasoning-effort ids Copilot models declare via `supports.reasoning_effort`. */
const EFFORT_NAMES = {
  off: "Off",
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max"
};

/**
 * Reasoning levels for Claude-family models. Copilot does not declare a
 * `reasoning_effort` list for them — only a thinking budget — and rejects
 * `reasoning_effort` outright; the accepted control is Anthropic adaptive
 * thinking (`thinking: { type: "enabled", effort }`), whose levels are
 * low/medium/high across the family.
 */
const CLAUDE_EFFORTS = [
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" }
];
//#endregion

//#region schema
const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1)
});
const Config = z.object({
  oauthTokenEnv: z.string().role("credential-ref").default(DEFAULT_OAUTH_TOKEN_ENV),
  baseURL: z.string(),
  models: z.array(catalogModel).default([]),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema
});
//#endregion

//#region serialize
/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks) {
  return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Reject image content in positions that do not support it (system/assistant/tool-result). */
function assertTextOnly(blocks, position) {
  if (contentHasImage(blocks)) throw new LlmError(`GitHub Copilot adapter does not support image content in ${position} messages.`, "UNSUPPORTED_CONTENT");
}
/**
 * Serialize one user content block list that may contain images.
 * Pure-text content is returned as a plain string (preserving provider-cache
 * compatibility). Mixed or image-only content is returned as a content-part
 * array in OpenAI image_url format, preserving original block order.
 */
async function serializeChatUserContent(blocks, imageResolver) {
  const hasImage = blocks.some((b) => b.type === "image");
  if (!hasImage) return flattenText(blocks);
  const parts = [];
  for (const block of blocks) {
    if (block.type === "text") {
      if (block.text.length > 0) parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      const resolved = await imageResolver.resolve(block.attachment);
      parts.push({ type: "image_url", image_url: { url: resolved.dataUrl } });
    }
    // Reasoning and unknown block types are silently skipped for user content.
  }
  return parts;
}
/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message) {
  const text = flattenText(message.content);
  const reasoning = message.content.filter((block) => block.type === "reasoning").map((block) => block.text).join("");
  const toolCalls = message.content.filter((block) => block.type === "tool-call").map((block) => ({
    id: block.id,
    type: "function",
    function: {
      name: block.name,
      arguments: block.arguments
    }
  }));
  return {
    role: "assistant",
    content: text,
    ...reasoning.length > 0 ? { reasoning_content: reasoning, reasoning_text: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
  };
}
/** Serialize the conversation into OpenAI-compatible wire messages. */
async function serializeMessages(messages, imageResolver) {
  const wire = [];
  for (const message of messages) {
    if (message.role === "system") {
      assertTextOnly(message.content, "system");
      wire.push({ role: "system", content: flattenText(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      assertTextOnly(message.content, "assistant");
      wire.push(serializeAssistant(message));
      continue;
    }
    // User messages: separate tool-result blocks from regular content.
    const toolResults = message.content.filter((block) => block.type === "tool-result");
    // First version: reject images inside tool-result content.
    for (const result of toolResults) {
      if (contentHasImage(result.content)) {
        throw new LlmError("GitHub Copilot adapter does not support image content in tool-result messages (first version).", "UNSUPPORTED_CONTENT");
      }
    }
    const userBlocks = message.content.filter((block) => block.type !== "tool-result");
    const text = flattenText(userBlocks);
    const hasImages = userBlocks.some((b) => b.type === "image");
    if (text.length > 0 || hasImages || toolResults.length === 0) {
      const content = await serializeChatUserContent(userBlocks, imageResolver);
      wire.push({ role: "user", content });
    }
    for (const result of toolResults) wire.push({
      role: "tool",
      tool_call_id: result.toolCallId,
      content: flattenText(result.content) || "(no output)"
    });
  }
  return wire;
}
/** Build the full wire request body (always streaming, usage reporting on). */
async function serializeRequest(options, wire, imageResolver) {
  const messages = [];
  if (options.system !== void 0) messages.push({ role: "system", content: options.system });
  messages.push(...await serializeMessages(options.messages, imageResolver));
  const tools = options.tools?.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...tools !== void 0 && tools.length > 0 ? { tools } : {},
    ...options.temperature !== void 0 ? { temperature: options.temperature } : {},
    ...options.maxTokens === void 0 ? {} : { max_tokens: options.maxTokens },
    ...options.stop !== void 0 ? { stop: options.stop } : {},
    ...wire === void 0 ? {} : wire.kind === "reasoning_effort" ? { reasoning_effort: wire.value } : { thinking: { type: "enabled", effort: wire.value } }
  };
}
//#endregion

//#region attachment resolver
/**
 * Per-request image resolver for the GitHub Copilot adapter.
 *
 * One instance is created per outgoing request. It reads image bytes from the
 * AttachmentStore, validates each image against model-level vision limits, and
 * encodes the bytes as a data URI for the Provider wire payload.
 *
 * The resolver caches results by attachmentId so the same image that appears
 * in multiple history messages is read and Base64-encoded only once. Unique
 * image count is tracked to enforce model-level `maxImages` before any I/O.
 *
 * Design notes:
 * - The caller must pass a non-null attachmentStore when the request contains
 *   images; absence is an error (the adapter pre-flight check guarantees this
 *   in the normal path, but resolve() also defends against null explicitly).
 * - The storage-layer's verified mediaType is always used; the caller's claim
 *   in the ImageBlock is never trusted.
 * - No token, image content, or data URI is written to any log.
 * - The provided AbortSignal is forwarded to attachmentStore.readImage().
 */
function createImageResolver(attachmentStore, model, signal) {
  /** @type {Map<string, Promise<{ref: any, bytes: number, mediaType: string, dataUrl: string}>>} */
  const cache = new Map();
  let uniqueCount = 0;
  const vision = model?.vision;

  /**
   * Resolve one image reference to a data URI.
   * @param {import('@deepseek-ai/dsh-llm').ImageBlock['attachment']} ref
   */
  const resolve = (ref) => {
    const id = ref.attachmentId;
    const hit = cache.get(id);
    if (hit !== undefined) return hit;

    // Count new unique images and enforce the per-request limit before I/O.
    uniqueCount++;
    if (vision?.maxImages !== undefined && uniqueCount > vision.maxImages) {
      const limit = vision.maxImages;
      const promise = Promise.reject(new LlmError(
        `GitHub Copilot model "${model.id}" accepts at most ${limit} image${limit === 1 ? "" : "s"} per request; this request contains ${uniqueCount}.`,
        "UNSUPPORTED_CONTENT"
      ));
      // Register the rejection so the caller can surface it; prevent
      // unhandled-rejection noise if the caller does not immediately await.
      promise.catch(() => void 0);
      cache.set(id, promise);
      return promise;
    }

    const promise = (async () => {
      if (attachmentStore == null) {
        throw new LlmError(
          "GitHub Copilot image input requires the durable attachment service",
          "UNSUPPORTED_CONTENT"
        );
      }
      const stored = await attachmentStore.readImage(ref, signal);
      // Always use the storage-layer verified media type.
      const mediaType = stored.ref.mediaType;
      const byteLength = stored.data.byteLength;

      if (vision?.mediaTypes !== undefined && !vision.mediaTypes.includes(mediaType)) {
        throw new LlmError(
          `GitHub Copilot model "${model.id}" does not accept ${mediaType}.`,
          "UNSUPPORTED_CONTENT"
        );
      }
      if (vision?.maxImageBytes !== undefined && byteLength > vision.maxImageBytes) {
        throw new LlmError(
          `GitHub Copilot model "${model.id}" accepts images up to ${vision.maxImageBytes} bytes; this image is ${byteLength} bytes.`,
          "UNSUPPORTED_CONTENT"
        );
      }

      // Encode to data URI without logging the content.
      const dataUrl = `data:${mediaType};base64,${Buffer.from(stored.data).toString("base64")}`;
      return { ref: stored.ref, bytes: byteLength, mediaType, dataUrl };
    })();

    cache.set(id, promise);
    return promise;
  };

  return { resolve };
}
//#endregion
//#region sse translate
/** Parse an SSE byte stream into data payloads. Chat-completions ends with `[DONE]`; Responses ends after its terminal event. */
async function* parseSse(stream, requireDone = true) {
  const events = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream());
  for await (const { data } of events) {
    yield data;
    if (data === "[DONE]") return;
  }
  if (requireDone) throw new LlmError("SSE stream ended without [DONE]", "STREAM_CLOSED");
}
/**
 * Optional diagnostic tap. When the environment variable DSH_COPILOT_TRACE is
 * truthy, log a one-line summary of every SSE payload to stderr, then re-yield
 * it unchanged. Understands BOTH wire formats:
 *   - Responses API events  (payload has `type`, optional `item`/`delta`/`text`)
 *   - chat-completions chunks (payload has `choices[].delta` with
 *     content / reasoning_content / reasoning_text / reasoning / tool_calls)
 * Off by default — zero overhead and no output in normal operation. Used to see
 * exactly which reasoning fields/events a given model emits so a missing Think
 * block can be diagnosed empirically instead of guessed at.
 */
async function* traceSse(payloads, label) {
  const on = (() => { try { return !!globalThis.process?.env?.DSH_COPILOT_TRACE; } catch { return false; } })();
  if (!on) { yield* payloads; return; }
  const log = (m) => { try { globalThis.process?.stderr?.write(`[copilot-trace ${label}] ${m}\n`); } catch {} };
  const len = (v) => typeof v === "string" ? `${v.length}b` : "-";
  for await (const payload of payloads) {
    if (payload === "[DONE]") { log("[DONE]"); yield payload; continue; }
    try {
      const e = JSON.parse(payload);
      if (typeof e.type === "string") {
        // Responses API event.
        const it = e.item?.type ? ` item=${e.item.type}` : "";
        const d = typeof e.delta === "string" ? ` delta=${len(e.delta)}` : "";
        const t = typeof e.text === "string" ? ` text=${len(e.text)}` : "";
        log(`${e.type}${it}${d}${t}`);
      } else if (Array.isArray(e.choices)) {
        // chat-completions chunk.
        for (const c of e.choices) {
          const d = c.delta ?? {};
          const fields = [];
          if (typeof d.content === "string" && d.content.length) fields.push(`content=${len(d.content)}`);
          if (typeof d.reasoning_content === "string") fields.push(`reasoning_content=${len(d.reasoning_content)}`);
          if (typeof d.reasoning_text === "string") fields.push(`reasoning_text=${len(d.reasoning_text)}`);
          if (typeof d.reasoning === "string") fields.push(`reasoning=${len(d.reasoning)}`);
          if (Array.isArray(d.tool_calls)) fields.push(`tool_calls=${d.tool_calls.length}`);
          if (c.finish_reason) fields.push(`finish=${c.finish_reason}`);
          log(`chunk keys=[${Object.keys(d).join(",")}]${fields.length ? " " + fields.join(" ") : ""}`);
        }
        if (e.usage) log(`usage ${JSON.stringify(e.usage)}`);
      } else {
        log(`<unknown payload keys=[${Object.keys(e).join(",")}]>`);
      }
    } catch { log("<unparseable payload>"); }
    yield payload;
  }
}
function mapFinishReason(reason) {
  switch (reason) {
    case "stop": return { kind: "stop" };
    case "tool_calls": return { kind: "tool-calls" };
    case "length": return { kind: "max-tokens" };
    default: return {
      kind: "error",
      failure: {
        message: `model stopped: ${reason}`,
        code: reason.toUpperCase()
      }
    };
  }
}
function mapUsage(usage) {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== void 0 ? { reasoningTokens: reasoning } : {}
  };
}
function closeBlock(block) {
  switch (block.kind) {
    case "text": return { type: "text", text: block.text };
    case "reasoning": return { type: "reasoning", text: block.text };
    case "tool-call": return {
      type: "tool-call",
      id: CallId(block.callId ?? ""),
      name: block.name ?? "",
      arguments: block.text
    };
  }
}
/** Consume SSE data payloads and yield harness StreamChunks. */
async function* translate(payloads) {
  let nextIndex = 0;
  let textBlock;
  let reasoningBlock;
  const toolBlocks = /* @__PURE__ */ new Map();
  const order = [];
  let pendingFinish;
  let pendingUsage;
  function open(kind) {
    const block = { index: nextIndex++, kind, text: "" };
    order.push(block);
    return block;
  }
  for await (const payload of payloads) {
    if (payload === "[DONE]") {
      for (const block of order) yield { type: "block-end", index: block.index, block: closeBlock(block) };
      if (pendingUsage) yield { type: "usage", usage: pendingUsage };
      const reason = pendingFinish ?? { kind: "stop" };
      yield {
        type: "finish",
        reason: reason.kind === "stop" && order.length === 0 ? {
          kind: "error",
          failure: { message: "model returned a completed response with no content", code: EMPTY_RESPONSE_CODE }
        } : reason
      };
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      const reasoning = typeof delta?.reasoning_content === "string" ? delta.reasoning_content
        : typeof delta?.reasoning_text === "string" ? delta.reasoning_text
        : typeof delta?.reasoning === "string" ? delta.reasoning : "";
      if (reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open("reasoning");
          yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
        }
        reasoningBlock.text += reasoning;
        yield { type: "reasoning-delta", index: reasoningBlock.index, text: reasoning };
      }
      const content = delta?.content;
      if (typeof content === "string" && content.length > 0) {
        if (!textBlock) {
          textBlock = open("text");
          yield { type: "block-start", index: textBlock.index, blockType: "text" };
        }
        textBlock.text += content;
        yield { type: "text-delta", index: textBlock.index, text: content };
      }
      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index);
        if (!block) {
          block = open("tool-call");
          toolBlocks.set(call.index, block);
          yield { type: "block-start", index: block.index, blockType: "tool-call" };
        }
        if (call.id !== void 0) block.callId = call.id;
        if (call.function?.name !== void 0) block.name = call.function.name;
        const fragment = call.function?.arguments ?? "";
        block.text += fragment;
        yield {
          type: "tool-call-delta",
          index: block.index,
          id: CallId(block.callId ?? ""),
          ...block.name !== void 0 ? { name: block.name } : {},
          argumentsDelta: fragment
        };
      }
      if (typeof choice.finish_reason === "string") pendingFinish = mapFinishReason(choice.finish_reason);
    }
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
  }
  throw new LlmError("SSE payload stream ended without [DONE]", "STREAM_CLOSED");
}
//#endregion

//#region responses api
/**
 * OpenAI Responses-API serialization + translation for models GitHub serves
 * only through `/responses` (the gpt-5.x family: gpt-5.4-mini, gpt-5.5,
 * gpt-5.6-*). The wire vocabulary mirrors the chat-completions adapter but
 * with Responses input items and streaming events.
 * @module dsh-llm-github-copilot/responses
 */
/** Serialize the conversation into Responses `input` items. */
async function serializeResponsesMessages(messages, imageResolver) {
  const input = [];
  for (const message of messages) {
    if (message.role === "system") {
      assertTextOnly(message.content, "system");
      input.push({ role: "system", content: [{ type: "input_text", text: flattenText(message.content) }] });
      continue;
    }
    if (message.role === "assistant") {
      assertTextOnly(message.content, "assistant");
      const text = flattenText(message.content);
      const toolCallBlocks = message.content.filter((block) => block.type === "tool-call");
      // In the Responses API, assistant text goes into an OutputMessage (type: "message"),
      // while tool calls are top-level `function_call` items — NOT nested inside the
      // message's content array (the only valid content types there are `output_text`
      // and `refusal`).  Mixing tool calls into content produces the server error:
      //   "Invalid value: 'output_tool_call'. Supported values are: 'output_text', ..."
      if (text.length > 0) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }]
        });
      }
      for (const block of toolCallBlocks) {
        input.push({
          type: "function_call",
          // The `id` field is omitted on purpose.  `FunctionToolCall`'s required
          // fields are only `type`/`call_id`/`name`/`arguments`; `id` is the
          // API-generated item id (`fc_...`) and is NOT required when replaying
          // history.  The harness ToolCallBlock carries only the provider-issued
          // `call_id` (`call_...`) — translate() drops the original `fc_...` item
          // id — and that `call_id` is what correlates the call with its matching
          // `function_call_output`.  Sending `id` forces the server to validate it
          // ("Expected an ID that begins with 'fc'"), so we simply omit it.
          call_id: block.id,
          name: block.name,
          arguments: block.arguments
        });
      }
      continue;
    }
    const toolResults = message.content.filter((block) => block.type === "tool-result");
    // First version: reject images inside tool-result content.
    for (const result of toolResults) {
      if (contentHasImage(result.content)) {
        throw new LlmError("GitHub Copilot adapter does not support image content in tool-result messages (first version).", "UNSUPPORTED_CONTENT");
      }
    }
    const userBlocks = message.content.filter((block) => block.type !== "tool-result");
    const text = flattenText(userBlocks);
    const hasImages = userBlocks.some((b) => b.type === "image");
    if (text.length > 0 || hasImages || toolResults.length === 0) {
      const contentParts = await serializeResponsesUserContent(userBlocks, imageResolver);
      input.push({ role: "user", content: contentParts });
    }
    for (const result of toolResults) input.push({
      type: "function_call_output",
      call_id: result.toolCallId,
      output: flattenText(result.content) || "(no output)"
    });
  }
  return input;
}
/**
 * Serialize one user content block list that may contain images for the
 * Responses API. Pure-text content produces a single input_text item;
 * mixed or image-only content produces an ordered array of input_text and
 * input_image items preserving the original block order.
 */
async function serializeResponsesUserContent(blocks, imageResolver) {
  const hasImage = blocks.some((b) => b.type === "image");
  if (!hasImage) return [{ type: "input_text", text: flattenText(blocks) || "" }];
  const parts = [];
  for (const block of blocks) {
    if (block.type === "text") {
      if (block.text.length > 0) parts.push({ type: "input_text", text: block.text });
    } else if (block.type === "image") {
      const resolved = await imageResolver.resolve(block.attachment);
      parts.push({ type: "input_image", image_url: resolved.dataUrl });
    }
    // Reasoning and unknown block types are silently skipped for user content.
  }
  return parts;
}
/** Build the full Responses wire request body. */
async function serializeResponsesRequest(options, wire, imageResolver, supportsReasoning = false) {
  const input = await serializeResponsesMessages(options.messages, imageResolver);
  if (options.system !== void 0) input.unshift({ role: "system", content: [{ type: "input_text", text: options.system }] });
  const tools = options.tools?.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
  // Always include reasoning.summary when the model supports reasoning so the
  // API emits response.reasoning_summary_text.delta events in the stream.
  // "detailed" yields multi-sentence summaries per reasoning step; "concise"
  // only emits a one-line title per step (which looked like the Think block was
  // "stuck" after one short line). When no effort is explicitly selected, omit
  // the effort field and let the API apply its own default; only the summary
  // key is required to unlock the streaming events.
  const reasoningParam = supportsReasoning
    ? { reasoning: { ...(wire !== void 0 ? { effort: wire.value } : {}), summary: "detailed" } }
    : wire !== void 0 ? { reasoning: { effort: wire.value, summary: "detailed" } }
    : {};
  return {
    model: options.model,
    input,
    stream: true,
    ...tools !== void 0 && tools.length > 0 ? { tools } : {},
    ...options.temperature !== void 0 ? { temperature: options.temperature } : {},
    ...options.maxTokens === void 0 ? {} : { max_output_tokens: options.maxTokens },
    ...options.stop !== void 0 ? { stop: options.stop } : {},
    ...reasoningParam
  };
}
function mapResponsesUsage(usage) {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const cacheRead = usage?.input_tokens_details?.cached_tokens;
  const reasoning = usage?.output_tokens_details?.reasoning_tokens;
  return {
    inputTokens: input - (cacheRead ?? 0),
    outputTokens: output,
    ...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== void 0 ? { reasoningTokens: reasoning } : {}
  };
}
/** Consume Responses SSE payloads and yield harness StreamChunks. */
async function* translateResponses(payloads) {
  let nextIndex = 0;
  let textBlock;
  // The currently open reasoning block. GitHub Copilot's gpt-5.x Responses
  // stream assigns a DIFFERENT opaque `item_id` to every reasoning event
  // (output_item.added, reasoning_summary_part.added, *_text.delta,
  // output_item.done all differ), so id-based matching is impossible. Reasoning
  // items are strictly sequential and non-overlapping, so a single reference to
  // the current open block routes every delta and closes it reliably.
  let reasoningBlock;
  // The currently open tool-call block. Same problem as reasoning: gpt-5.x
  // assigns a DIFFERENT opaque item_id to output_item.added,
  // function_call_arguments.delta/.done, and output_item.done, so a map lookup
  // by item_id never hits — every argument delta was dropped and the block's
  // arguments stayed empty, which made the client's JSON.parse("") throw
  // "Unexpected end of JSON input". Tool calls stream sequentially and do not
  // overlap, so a single reference routes deltas and closes the block reliably.
  let toolBlock;
  const toolBlocks = /* @__PURE__ */ new Map();
  const reasoningBlocks = /* @__PURE__ */ new Map();
  const order = [];
  let finishReason;
  let usage;
  let failure;
  const open = (kind) => {
    const block = { index: nextIndex++, kind, text: "" };
    order.push(block);
    return block;
  };
  const close = (block) => {
    switch (block.kind) {
      case "text": return { type: "text", text: block.text };
      case "reasoning": return { type: "reasoning", text: block.text };
      case "tool-call": return {
        type: "tool-call",
        id: CallId(block.callId ?? ""),
        name: block.name ?? "",
        arguments: block.text
      };
    }
  };

  for await (const payload of payloads) {
    if (payload === "[DONE]") break;
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      throw new LlmError("malformed SSE payload", "MALFORMED_RESPONSE");
    }
    switch (event.type) {
      case "response.output_item.added": {
        const item = event.item;
        if (item?.type === "function_call") {
          const block = open("tool-call");
          toolBlock = block;
          toolBlocks.set(item.id ?? "", block);
          if (typeof item.name === "string") block.name = item.name;
          if (typeof item.call_id === "string") block.callId = item.call_id;
          yield { type: "block-start", index: block.index, blockType: "tool-call" };
        } else if (item?.type === "reasoning") {
          const block = open("reasoning");
          reasoningBlock = block;
          reasoningBlocks.set(item.id ?? "", block);
          yield { type: "block-start", index: block.index, blockType: "reasoning" };
        }
        break;
      }
      case "response.content_part.added": {
        // Open the text block lazily and exactly once. Emitting block-start only
        // when no text block is open avoids both a missing block-start (when the
        // first signal is output_text.delta) and a duplicate block-start (when
        // content_part.added fires after a delta already opened the block).
        if (event.part?.type === "output_text" && textBlock === void 0) {
          textBlock = open("text");
          yield { type: "block-start", index: textBlock.index, blockType: "text" };
        }
        break;
      }
      case "response.output_text.delta": {
        // Some Copilot endpoints stream output_text.delta without a preceding
        // content_part.added. Lazily open + start the text block here so the
        // delta always addresses an open block (else the harness stream
        // invariant throws "text delta requires an open text block").
        if (textBlock === void 0) {
          textBlock = open("text");
          yield { type: "block-start", index: textBlock.index, blockType: "text" };
        }
        textBlock.text += event.delta ?? "";
        yield { type: "text-delta", index: textBlock.index, text: event.delta ?? "" };
        break;
      }
      case "response.reasoning_summary_part.added": {
        // A reasoning item may contain multiple summary parts. Insert a blank
        // line between parts so distinct summary paragraphs stay separated in
        // the Think block. The first part (empty block) needs no separator.
        if (reasoningBlock !== void 0 && reasoningBlock.text.length > 0) {
          reasoningBlock.text += "\n\n";
          yield { type: "reasoning-delta", index: reasoningBlock.index, text: "\n\n" };
        }
        break;
      }
      // GitHub Copilot's gpt-5.x (e.g. gpt-5.6 "luna") streams raw reasoning as
      // `response.reasoning_text.delta` rather than the summary variant. Handle
      // BOTH: without this the reasoning block is created (block-start /
      // block-end) but never receives a reasoning-delta, so the Think block
      // appears yet its content never updates. Lazily open the reasoning block
      // so a delta arriving before output_item.added still streams.
      case "response.reasoning_text.delta":
      case "response.reasoning_summary_text.delta": {
        if (reasoningBlock === void 0) {
          reasoningBlock = open("reasoning");
          yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
        }
        reasoningBlock.text += event.delta ?? "";
        yield { type: "reasoning-delta", index: reasoningBlock.index, text: event.delta ?? "" };
        break;
      }
      // Some Copilot endpoints send the complete reasoning only on the terminal
      // `.done` event (with the full string in `event.text`) and emit no
      // deltas. Backfill so the Think block still shows substantive content.
      case "response.reasoning_text.done":
      case "response.reasoning_summary_text.done": {
        if (typeof event.text === "string" && event.text.length > 0) {
          if (reasoningBlock === void 0) {
            reasoningBlock = open("reasoning");
            yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
          }
          if (reasoningBlock.text.length === 0) {
            reasoningBlock.text = event.text;
            yield { type: "reasoning-delta", index: reasoningBlock.index, text: event.text };
          }
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const block = toolBlock ?? order.find((b) => b.kind === "tool-call" && !b._closed);
        if (block !== void 0) {
          block.text += event.delta ?? "";
          yield {
            type: "tool-call-delta",
            index: block.index,
            id: CallId(block.callId ?? ""),
            ...block.name !== void 0 ? { name: block.name } : {},
            argumentsDelta: event.delta ?? ""
          };
        }
        break;
      }
      case "response.function_call_arguments.done": {
        // `arguments` here is "the final arguments as a JSON string" — the
        // authoritative complete value.  The delta stream only forwards the
        // opening/closing quotes on some Copilot endpoints, so this event (not
        // the deltas) is what must populate the block's final arguments.
        // Route by the tracked reference: the item_id here differs from the one
        // in output_item.added, so a map lookup would miss.
        const block = toolBlock ?? order.find((b) => b.kind === "tool-call" && !b._closed);
        if (block !== void 0 && typeof event.arguments === "string" && event.arguments.length > 0) {
          block.text = event.arguments;
        }
        break;
      }
      case "response.output_item.done": {
        const item = event.item;
        if (item?.type === "message" && textBlock !== void 0) {
          textBlock._closed = true;
          yield { type: "block-end", index: textBlock.index, block: { type: "text", text: textBlock.text } };
          textBlock = void 0;
        } else if (item?.type === "function_call") {
          // Close by the tracked reference, NOT by item.id (which differs from
          // output_item.added's id). item.arguments here is the authoritative
          // complete JSON string; prefer it, else keep what .done captured.
          const block = toolBlock ?? order.find((b) => b.kind === "tool-call" && !b._closed);
          if (block !== void 0) {
            if (typeof item.name === "string") block.name = item.name;
            if (typeof item.call_id === "string") block.callId = item.call_id;
            // Only overwrite with a non-empty value: an empty/absent `arguments`
            // here must not clobber arguments already captured from
            // `response.function_call_arguments.done` (or the delta stream).
            if (typeof item.arguments === "string" && item.arguments.length > 0) block.text = item.arguments;
            block._closed = true;
            yield { type: "block-end", index: block.index, block: close(block) };
            if (toolBlock === block) toolBlock = void 0;
            toolBlocks.delete(item.id ?? "");
          }
        } else if (item?.type === "reasoning") {
          // Close by the tracked reference, NOT by item.id: the id in this
          // done event differs from the one in output_item.added, so a map
          // lookup would miss and the reasoning block would never emit
          // block-end — leaving the Think row stuck "streaming" forever and
          // corrupting the next reasoning segment.
          const block = reasoningBlock ?? order.find((b) => b.kind === "reasoning" && !b._closed);
          if (block !== void 0) {
            block._closed = true;
            yield { type: "block-end", index: block.index, block: { type: "reasoning", text: block.text } };
            if (reasoningBlock === block) reasoningBlock = void 0;
            reasoningBlocks.delete(item.id ?? "");
          }
        }
        break;
      }
      case "response.completed": {
        usage = mapResponsesUsage(event.response?.usage);
        finishReason = { kind: "stop" };
        break;
      }
      case "response.incomplete": {
        finishReason = event.response?.incomplete_details?.reason === "max_output_tokens" ? { kind: "max-tokens" } : { kind: "stop" };
        break;
      }
      case "response.failed": {
        const error = event.response?.error;
        failure = {
          kind: "error",
          failure: { message: error?.message ?? "model failed", code: typeof error?.code === "string" ? error.code.toUpperCase() : "MODEL_FAILED" }
        };
        break;
      }
      case "error": {
        failure = {
          kind: "error",
          failure: { message: event.message ?? "unknown error", code: typeof event.code === "string" ? event.code.toUpperCase() : "RESPONSES_ERROR" }
        };
        break;
      }
    }
  }
  // Close any blocks that weren't closed by their done events (defensive).
  for (const block of order) {
    if (block._closed) continue;
    block._closed = true;
    yield { type: "block-end", index: block.index, block: close(block) };
  }
  // usage before finish — consistent with translate() and the harness consumer contract.
  if (usage !== void 0) yield { type: "usage", usage };
  if (failure !== void 0) yield { type: "finish", reason: failure };
  else if (finishReason !== void 0 && order.length === 0) yield {
    type: "finish",
    reason: {
      kind: "error",
      failure: { message: "model returned a completed response with no content", code: EMPTY_RESPONSE_CODE }
    }
  };
  else yield { type: "finish", reason: finishReason ?? { kind: "stop" } };
}
//#endregion

//#region token exchange
function deriveBaseUrlFromProxyEp(apiToken) {
  const match = /(?:^|;)\s*proxy-ep=([^;\s]+)/.exec(apiToken);
  if (match === null) return void 0;
  let host = match[1];
  for (const prefix of ["https://", "http://"]) if (host.startsWith(prefix)) host = host.slice(prefix.length);
  host = host.replace(/\/+$/, "");
  if (host.startsWith("proxy.")) host = "api." + host.slice("proxy.".length);
  return `https://${host}`;
}
/**
 * Exchange a long-lived GitHub token for a short-lived Copilot API token and
 * the account-specific API base URL, matching VS Code / Copilot CLI behavior.
 */
async function exchangeCopilotToken(rawToken) {
  let response;
  try {
    response = await copilotFetch(TOKEN_EXCHANGE_URL, {
      method: "GET",
      headers: {
        authorization: `token ${rawToken}`,
        accept: "application/json",
        "editor-version": EDITOR_VERSION,
        "editor-plugin-version": EDITOR_PLUGIN_VERSION,
        "user-agent": EXCHANGE_USER_AGENT
      }
    });
  } catch (error) {
    throw new LlmError(`GitHub Copilot token exchange request failed`, "TRANSPORT", { cause: error });
  }
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 || response.status === 404 ? "AUTH" : response.status >= 500 ? "SERVER" : "TRANSPORT";
    throw new LlmError(`GitHub Copilot token exchange failed (HTTP ${response.status})`, code, { status: response.status });
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new LlmError("GitHub Copilot token exchange did not answer with JSON", "TRANSPORT");
  }
  const apiToken = data.token;
  if (typeof apiToken !== "string" || apiToken.length === 0) throw new LlmError("GitHub Copilot token exchange returned no token", "AUTH");
  const expiresAt = Number(data.expires_at) || Date.now() / 1000 + 1800;
  let baseUrl;
  if (typeof data.endpoints?.api === "string" && data.endpoints.api.length > 0) baseUrl = data.endpoints.api.replace(/\/+$/, "");
  if (!baseUrl) baseUrl = deriveBaseUrlFromProxyEp(apiToken);
  return { apiToken, expiresAtMs: expiresAt * 1000, baseUrl };
}
//#endregion

//#region transport
/**
 * Copilot request transport. GitHub serves the full Copilot model catalog
 * (Claude included) only to connections that arrive through the environment's
 * proxy egress. The undici `ProxyAgent` routes each request through
 * `https_proxy`/`HTTPS_PROXY`/`http_proxy`/`HTTP_PROXY` (+ `NO_PROXY`) at
 * runtime — no launch flag needed — and falls back to the global fetch when
 * no proxy applies. A hand-rolled CONNECT tunnel is deliberately NOT used:
 * on mixed-mode proxies it bypasses the proxy egress and GitHub then serves
 * a reduced catalog.
 */
import undici from "undici";
const ProxyAgent = undici.ProxyAgent;
let proxyDispatcherCache;
function resolveHttpProxy() {
  const order = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"];
  for (const key of order) {
    const value = process.env[key];
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return value;
    } catch {}
  }
  return void 0;
}
function isProxyBypassed(hostname) {
  const raw = process.env.no_proxy ?? process.env.NO_PROXY;
  if (!raw) return false;
  const host = hostname.toLowerCase();
  return raw.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean).some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.includes("/")) return false; // CIDR ranges are not supported
    const base = pattern.startsWith(".") ? pattern.slice(1) : pattern;
    return host === base || host.endsWith("." + base);
  });
}
/** A cached undici ProxyAgent for the current proxy URL, or undefined when no proxy applies. */
function proxyDispatcher() {
  const url = resolveHttpProxy();
  if (url === void 0) return void 0;
  if (proxyDispatcherCache !== void 0 && proxyDispatcherCache.url === url) return proxyDispatcherCache.agent;
  const agent = new ProxyAgent(url);
  proxyDispatcherCache = { url, agent };
  return agent;
}
async function copilotFetch(url, init = {}) {
  const target = new URL(url);
  const dispatcher = target.protocol === "https:" && !isProxyBypassed(target.hostname) ? proxyDispatcher() : void 0;
  if (dispatcher === void 0) return fetch(url, init);
  return fetch(url, { ...init, dispatcher });
}
//#endregion

//#region adapter
/**
 * Per-model DSH reasoning-effort metadata, derived from the levels the live
 * catalog declares for that model. `none` (gpt-5.x "no reasoning") is exposed
 * as the conventional `off` id. No default effort is set: when the caller does
 * not pick a level, no reasoning parameter is sent and the API default applies.
 */
function reasoningMetadata(entry) {
  const list = entry?.reasoningEffort;
  if (Array.isArray(list) && list.length > 0) {
    return {
      efforts: list.map((value) => ({
        id: value === "none" ? "off" : value,
        name: EFFORT_NAMES[value] ?? value[0].toUpperCase() + value.slice(1)
      }))
    };
  }
  if (entry?.thinkingBudgets !== void 0) return { efforts: CLAUDE_EFFORTS };
  return void 0;
}
/**
 * Map a requested reasoning-effort id onto this model's wire parameter. DSH
 * validates ids against the declared efforts first, so the miss branch is
 * defensive only. Returns undefined when the model has no reasoning control.
 */
function wireReasoning(entry, effort) {
  if (effort === void 0 || entry === void 0) return void 0;
  const list = entry.reasoningEffort;
  if (Array.isArray(list) && list.length > 0) {
    const accepted = list.includes(effort) || effort === "off" && list.includes("none");
    if (!accepted) return void 0;
    return { kind: "reasoning_effort", value: effort === "off" ? "none" : effort };
  }
  if (entry.thinkingBudgets !== void 0 && CLAUDE_EFFORTS.some((candidate) => candidate.id === effort)) {
    return { kind: "thinking_effort", value: effort };
  }
  return void 0;
}
function modelInfo(provider, model) {
  const reasoning = reasoningMetadata(model);
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === void 0 ? {} : { description: model.description },
    inputModalities: model.inputModalities ?? ["text"],
    ...reasoning === void 0 ? {} : { reasoning }
  };
}
function providerRetryAfterMs(value) {
  if (value === null) return void 0;
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1000;
    return Number.isFinite(delay) && delay > 0 ? delay : void 0;
  }
  const delay = Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? delay : void 0;
}
function requestId(headers) {
  const value = headers.get("x-request-id") ?? headers.get("x-github-request-id");
  return value === null || value.length === 0 ? void 0 : ProviderRequestId(value);
}
function httpErrorCode(status, error) {
  if (status === 401 || status === 403) return "AUTH";
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(" ");
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
  if (status === 429) return "RATE_LIMIT";
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
    return "INVALID_REQUEST";
  }
  if (status >= 500) return "SERVER";
  return `HTTP_${status}`;
}

/**
 * Fetch + SSE against the Copilot chat-completions endpoint. Connection facts
 * resolve per request through thunks owned by the registering plugin.
 */
var GitHubCopilotAdapter = class extends LlmAdapter {
  config;
  constructor(config) {
    super();
    this.config = config;
  }
  providerInfo(provider) {
    return { id: provider, name: DISPLAY_NAME };
  }
  providerRetryPolicy(_provider) {
    return this.config.options().retryPolicy;
  }
  async listModels(provider) {
    const models = await this.config.catalog();
    return models.map((model) => modelInfo(provider, model));
  }
  resolveModel(provider, model, _signal) {
    return this.config.resolveModel(provider, model);
  }
  async *stream(options) {
    const connection = await this.config.resolveConnection();
    const consumer = new AbortController();
    const signal = options.signal === void 0 ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
    try {
      yield* this.request(options, signal, connection);
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError("GitHub Copilot request aborted by caller", "ABORTED", { cause: error });
      if (error instanceof LlmError) throw error;
      throw new LlmError(`GitHub Copilot API stream from ${connection.baseUrl} failed`, "TRANSPORT", { cause: error });
    } finally {
      consumer.abort("GitHub Copilot stream consumer stopped");
    }
  }
  async *request(options, signal, connection) {
    const models = await this.config.catalog();
    const entry = models.find((candidate) => candidate.id === options.model);
    const endpoints = entry?.endpoints;
    // Prefer the Responses API whenever the model offers it. gpt-5.x models that
    // advertise BOTH /responses and /chat/completions (gpt-5.4, gpt-5-mini) hide
    // their reasoning on /chat/completions — the stream reports reasoning_tokens
    // in usage but never streams the reasoning text, so the Think block stays
    // empty. On /responses the same models emit reasoning_summary_text /
    // reasoning_text deltas, so routing there restores live Think content and
    // matches how the /responses-only gpt-5.x models already behave.
    const useResponses = Array.isArray(endpoints) && endpoints.includes("/responses");
    const wire = wireReasoning(entry, options.reasoningEffort);
    const supportsReasoning = reasoningMetadata(entry) !== void 0;
    // Image pre-flight: gate model capability and attachment-service presence
    // before doing any I/O. Text-only requests skip this entirely.
    const containsImage = options.messages.some((m) => contentHasImage(m.content));
    let attachmentStore;
    if (containsImage) {
      const modalities = entry?.inputModalities ?? ["text"];
      if (!modalities.includes("image")) {
        throw new LlmError(
          `GitHub Copilot model "${options.model}" does not support image input.`,
          "UNSUPPORTED_CONTENT"
        );
      }
      attachmentStore = this.config.resolveAttachments();
      if (attachmentStore == null) {
        throw new LlmError(
          "GitHub Copilot image input requires the durable attachment service",
          "UNSUPPORTED_CONTENT"
        );
      }
    }
    const imageResolver = createImageResolver(attachmentStore, entry, signal);
    const body = useResponses ? await serializeResponsesRequest(options, wire, imageResolver, supportsReasoning) : await serializeRequest(options, wire, imageResolver);
    const payload = JSON.stringify(body);
    const path = useResponses ? "/responses" : "/chat/completions";
    const headers = {
      authorization: `Bearer ${connection.apiToken}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      "copilot-integration-id": INTEGRATION_ID,
      "editor-version": EDITOR_VERSION,
      "editor-plugin-version": EDITOR_PLUGIN_VERSION,
      "user-agent": EXCHANGE_USER_AGENT,
      "x-initiator": options.messages.length > 0 && options.messages[options.messages.length - 1].role !== "user" ? "agent" : "user",
      "openai-intent": "conversation-edits",
      ...attributionHeaders(),
      ...options.purpose === "compaction" ? { "x-dsh-harness-compact": "1" } : {}
    };
    let response;
    try {
      response = await copilotFetch(`${connection.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: payload,
        signal
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new LlmError(`GitHub Copilot API request to ${connection.baseUrl} failed`, "TRANSPORT", { cause: error });
    }
    if (!response.ok) {
      let message = `GitHub Copilot API error (HTTP ${response.status})`;
      let providerError;
      try {
        providerError = (await response.json()).error;
        if (providerError?.message) message = providerError.message;
      } catch {}
      const delay = providerRetryAfterMs(response.headers.get("retry-after"));
      const id = requestId(response.headers);
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        status: response.status,
        ...delay === void 0 ? {} : { providerRetryAfterMs: delay },
        ...id === void 0 ? {} : { requestId: id }
      });
    }
    if (!response.body) throw new LlmError("GitHub Copilot API returned no response body", "EMPTY_RESPONSE");
    yield* useResponses
      ? translateResponses(traceSse(parseSse(response.body, false), "responses"))
      : translate(traceSse(parseSse(response.body), "chat"));
  }
};
//#endregion

//#region model discovery
/** Whether a Copilot model is served by an endpoint this adapter speaks (/chat/completions or /responses). */
function isServedByAdapter(raw) {
  // Non-chat capabilities (e.g. embeddings) are never served by either endpoint.
  const type = raw?.capabilities?.type;
  if (type !== void 0 && type !== "chat") return false;
  // Internal routing models carry no user-facing meaning.
  if (typeof raw?.id === "string" && raw.id.includes("compaction")) return false;
  const endpoints = raw?.supported_endpoints;
  if (Array.isArray(endpoints) && endpoints.length > 0) {
    return endpoints.includes("/chat/completions") || endpoints.includes("/responses");
  }
  return true; // legacy models with no declared endpoints are chat/completions models
}
function readModelsListing(body) {
  const data = body?.data;
  if (!Array.isArray(data)) return void 0;
  const models = [];
  for (const raw of data) {
    const id = raw?.id;
    if (typeof id !== "string" || id.length === 0) continue;
    if (!isServedByAdapter(raw)) continue;
    const entry = { id };
    if (typeof raw?.name === "string" && raw.name.length > 0) entry.name = raw.name;
    else if (typeof raw?.display_name === "string" && raw.display_name.length > 0) entry.name = raw.display_name;
    const limits = raw?.capabilities?.limits;
    const contextWindow = limits?.max_context_window_tokens ?? raw?.context_window ?? raw?.context_length;
    if (typeof contextWindow === "number" && Number.isInteger(contextWindow) && contextWindow > 0) entry.contextWindow = contextWindow;
    const maxTokens = limits?.max_output_tokens ?? raw?.max_output_tokens ?? raw?.max_tokens;
    if (typeof maxTokens === "number" && Number.isInteger(maxTokens) && maxTokens > 0) entry.maxTokens = maxTokens;
    if (Array.isArray(raw?.supported_endpoints) && raw.supported_endpoints.length > 0) entry.endpoints = raw.supported_endpoints;
    // Per-model reasoning definition: the endpoint declares exactly which
    // reasoning-effort levels a model supports (gpt-5.x / gemini / kimi), while
    // Claude-family models expose a thinking budget instead of effort levels.
    const supports = raw?.capabilities?.supports;
    const reasoningEffort = supports?.reasoning_effort;
    if (Array.isArray(reasoningEffort) && reasoningEffort.length > 0) entry.reasoningEffort = reasoningEffort;
    const minBudget = supports?.min_thinking_budget;
    const maxBudget = supports?.max_thinking_budget;
    if (Number.isFinite(minBudget) || Number.isFinite(maxBudget)) entry.thinkingBudgets = {
      ...Number.isFinite(minBudget) ? { min: minBudget } : {},
      ...Number.isFinite(maxBudget) ? { max: maxBudget } : {}
    };
    // Vision capability: only declare image modality when the endpoint explicitly
    // reports supports.vision === true. Never infer from model name or family.
    if (supports?.vision === true) {
      entry.inputModalities = ["text", "image"];
      const vl = limits?.vision;
      if (vl !== null && typeof vl === "object") {
        const vision = {};
        const rawBytes = vl.max_prompt_image_size;
        if (typeof rawBytes === "number" && Number.isInteger(rawBytes) && rawBytes > 0) vision.maxImageBytes = rawBytes;
        const rawImages = vl.max_prompt_images;
        if (typeof rawImages === "number" && Number.isInteger(rawImages) && rawImages > 0) vision.maxImages = rawImages;
        const rawTypes = vl.supported_media_types;
        if (Array.isArray(rawTypes)) {
          const types = [...new Set(rawTypes.filter((t) => typeof t === "string" && t.length > 0))];
          if (types.length > 0) vision.mediaTypes = types;
        }
        if (Object.keys(vision).length > 0) entry.vision = vision;
      }
    } else {
      entry.inputModalities = ["text"];
    }
    models.push(entry);
  }
  return models.length > 0 ? models : void 0;
}
//#endregion

//#region config resolution
function resolveAdapterOptions(config, environment) {
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`${name}: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
  return {
    oauthTokenEnv: credentialRef(config.oauthTokenEnv ?? DEFAULT_OAUTH_TOKEN_ENV),
    baseURL: config.baseURL ?? void 0,
    models: (config.models ?? []).map((model) => ({
      id: model.id,
      ...model.name === void 0 ? {} : { name: model.name },
      ...model.description === void 0 ? {} : { description: model.description },
      ...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens }
    })),
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    defaultMaxTokens: config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, `${name}: retryPolicy`)
  };
}
//#endregion

//#region device flow
async function startDeviceFlow() {
  let response;
  try {
    response = await copilotFetch(DEVICE_CODE_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": EXCHANGE_USER_AGENT
      },
      body: new URLSearchParams({ client_id: OAUTH_CLIENT_ID, scope: OAUTH_SCOPE }).toString()
    });
  } catch (error) {
    throw new LlmError("failed to start GitHub device authorization", "TRANSPORT", { cause: error });
  }
  if (!response.ok) throw new LlmError(`GitHub device authorization failed (HTTP ${response.status})`, response.status >= 500 ? "SERVER" : "TRANSPORT", { status: response.status });
  const data = await response.json();
  const deviceCode = data.device_code;
  const userCode = data.user_code;
  if (typeof deviceCode !== "string" || deviceCode.length === 0 || typeof userCode !== "string" || userCode.length === 0) throw new LlmError("GitHub did not return a device code", "TRANSPORT");
  return {
    deviceCode,
    userCode,
    verificationUri: typeof data.verification_uri === "string" && data.verification_uri.length > 0 ? data.verification_uri : VERIFICATION_URI,
    interval: Math.max(Number(data.interval) || 5, 1),
    expiresIn: Number(data.expires_in) || 900
  };
}
async function pollDeviceFlow(device) {
  const body = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    device_code: device.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code"
  }).toString();
  let response;
  try {
    response = await copilotFetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": EXCHANGE_USER_AGENT
      },
      body
    });
  } catch {
    return { state: "retry" };
  }
  if (!response.ok) return { state: "retry" };
  const data = await response.json();
  if (typeof data.access_token === "string" && data.access_token.length > 0) return { state: "done", token: data.access_token };
  switch (data.error) {
    case "authorization_pending": return { state: "retry" };
    case "slow_down": return { state: "slow-down" };
    case "expired_token": return { state: "expired" };
    case "access_denied": return { state: "denied" };
    default: return { state: "error", message: data.error ?? "unknown" };
  }
}
//#endregion

//#region apply
function apply(ctx, config) {
  let current = () => config;
  let lastRaw;
  let lastGood;
  const options = () => {
    const raw = current();
    if (raw === lastRaw && lastGood !== void 0) return lastGood;
    try {
      const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx));
      lastRaw = raw;
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === void 0) throw error;
      lastRaw = raw;
      ctx.logger.error(`${name}: keeping the last good configuration after an invalid settings section`);
      ctx.logger.error(error);
      return lastGood;
    }
  };
  options();

  // ── credential resolution ────────────────────────────────────────────────
  const resolveRawOAuthToken = async () => {
    const ref = options().oauthTokenEnv;
    const credentials = ctx.get("credentials");
    if (credentials !== void 0) {
      const hit = await credentials.resolve(ref);
      if (hit !== void 0 && hit.value.length > 0) return assertUsableApiKey(hit.value, name, ref);
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref);
      if (ambient !== void 0 && ambient.value.length > 0) return assertUsableApiKey(ambient.value, name, ref);
    }
    return void 0;
  };
  const storeRawOAuthToken = async (token) => {
    const ref = options().oauthTokenEnv;
    const credentials = ctx.get("credentials");
    if (credentials === void 0) throw new LlmError(`GitHub Copilot sign-in needs the credentials service to store ${ref}`, "MISSING_CREDENTIAL");
    await credentials.set(ref, token);
  };

  // ── Copilot token exchange cache ─────────────────────────────────────────
  let exchangeCache;
  const resolveConnection = async () => {
    const raw = await resolveRawOAuthToken();
    if (raw === void 0) throw new LlmError(`GitHub Copilot: no GitHub OAuth token; run /copilot-login or store ${options().oauthTokenEnv}`, "MISSING_CREDENTIAL");
    const cached = exchangeCache;
    if (cached !== void 0 && cached.raw === raw && Date.now() < cached.expiresAtMs - TOKEN_REFRESH_MARGIN_MS) return cached.connection;
    const exchanged = await exchangeCopilotToken(raw);
    const connection = {
      apiToken: exchanged.apiToken,
      baseUrl: exchanged.baseUrl ?? options().baseURL ?? DEFAULT_BASE_URL
    };
    exchangeCache = { raw, expiresAtMs: exchanged.expiresAtMs, connection };
    return connection;
  };

  // ── model catalog discovery ─────────────────────────────────────────────
  let catalogCache;
  const catalog = async () => {
    const configured = options().models;
    const cached = catalogCache;
    if (cached !== void 0 && Date.now() < cached.at + CATALOG_TTL_MS) return cached.models;
    // Never advertise models that cannot be called. In particular, the old
    // DEFAULT_MODELS fallback made an unauthenticated provider look usable in
    // every model picker even though every request would fail MISSING_CREDENTIAL.
    const raw = await resolveRawOAuthToken();
    if (raw === void 0) {
      const models = [];
      catalogCache = { at: Date.now(), models };
      return models;
    }
    try {
      const connection = await resolveConnection();
      const response = await copilotFetch(`${connection.baseUrl}/models`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${connection.apiToken}`,
          accept: "application/json",
          "copilot-integration-id": INTEGRATION_ID,
          "editor-version": EDITOR_VERSION,
          ...attributionHeaders()
        }
      });
      if (!response.ok) throw new LlmError(`GitHub Copilot /models answered ${response.status}`, "DISCOVERY_FAILED");
      const discovered = readModelsListing(await response.json());
      if (discovered !== void 0) {
        catalogCache = { at: Date.now(), models: discovered };
        return discovered;
      }
    } catch (error) {
      ctx.logger.warn(`${name}: model discovery failed; using configured or default catalog`);
      ctx.logger.warn(error);
    }
    // A configured static catalog is only a metadata fallback for an account
    // that has a credential. Without an explicit catalog, failed token
    // exchange/discovery advertises no models rather than eight unusable ones.
    const fallback = configured.length > 0 ? configured : [];
    catalogCache = { at: Date.now(), models: fallback };
    return fallback;
  };
  const resolveModel = async (provider, model) => {
    const models = await catalog();
    const configured = models.find((entry) => entry.id === model);
    return {
      ...configured === void 0 ? { provider, id: model, name: model, inputModalities: ["text"] } : modelInfo(provider, configured),
      context: { contextWindow: configured?.contextWindow ?? options().defaultContextWindow },
      defaultMaxTokens: configured?.maxTokens ?? options().defaultMaxTokens
    };
  };

  // ── adapter + registrations ──────────────────────────────────────────────
  const adapter = new GitHubCopilotAdapter({
    options,
    catalog,
    resolveModel,
    resolveConnection,
    resolveAttachments: () => ctx.get("attachments")
  });
  ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: DISPLAY_NAME,
    settingsNs: NS,
    settingsPath: []
  }]);
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
  // Credential writes are a separate configuration plane. Whenever this
  // plugin's OAuth reference changes (our device flow, Settings, or an
  // external credentials-file edit), invalidate both token/catalog caches and
  // re-commit the adapter route. That emits llm/adapters-updated; every open
  // browser model directory then refetches session.models automatically.
  ctx.on("credentials/updated", (ref) => {
    if (ref !== options().oauthTokenEnv) return;
    exchangeCache = void 0;
    catalogCache = void 0;
    registration.replace([PROVIDER]);
  });
  let registeredPolicy = options().retryPolicy;
  const ensureRegistrationFacts = () => {
    const policy = options().retryPolicy;
    if (deepEqualJson(policy, registeredPolicy)) return;
    registration.replace([PROVIDER]);
    registeredPolicy = policy;
  };
  ctx.llm.registerModelDiscovery(NS, async (request) => {
    const models = await catalog();
    return models;
  });
  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source;
    },
    onChange: ensureRegistrationFacts
  });

  // ── shared OAuth controller (commands + Web settings page) ────────────────
  const activeTimers = /* @__PURE__ */ new Set();
  let authGeneration = 0;
  let authFlow;
  const clearAuthTimers = () => {
    for (const timer of activeTimers) clearTimeout(timer);
    activeTimers.clear();
  };
  ctx.effect(() => () => {
    authGeneration += 1;
    clearAuthTimers();
  });
  const publicFlow = (flow) => flow === void 0 ? void 0 : {
    state: flow.state,
    ...flow.verificationUri === void 0 ? {} : { verificationUri: flow.verificationUri },
    ...flow.userCode === void 0 ? {} : { userCode: flow.userCode },
    ...flow.expiresAt === void 0 ? {} : { expiresAt: flow.expiresAt },
    ...flow.message === void 0 ? {} : { message: flow.message }
  };
  const schedulePoll = (device) => {
    clearAuthTimers();
    const generation = ++authGeneration;
    let interval = device.interval;
    const deadline = Date.now() + device.expiresIn * 1000;
    authFlow = {
      state: "pending",
      verificationUri: device.verificationUri,
      userCode: device.userCode,
      expiresAt: deadline
    };
    let timer;
    const finish = (state, message) => {
      if (generation !== authGeneration) return;
      authFlow = { state, ...message === void 0 ? {} : { message } };
    };
    const tick = async () => {
      activeTimers.delete(timer);
      if (generation !== authGeneration) return;
      if (Date.now() > deadline) {
        finish("expired", "The device code expired. Start sign-in again.");
        ctx.logger.warn(`${name}: device authorization expired`);
        return;
      }
      const result = await pollDeviceFlow(device);
      if (generation !== authGeneration) return;
      if (result.state === "done") {
        try {
          // credentials.set emits credentials/updated after its durable
          // commit; the listener above invalidates caches and refreshes every
          // open model directory before this flow settles authenticated.
          await storeRawOAuthToken(result.token);
          finish("authenticated");
          ctx.logger.info(`${name}: GitHub Copilot sign-in completed; token stored as ${options().oauthTokenEnv}`);
        } catch (error) {
          finish("error", error instanceof Error ? error.message : String(error));
          ctx.logger.error(`${name}: failed to store the Copilot credential`);
          ctx.logger.error(error);
        }
        return;
      }
      switch (result.state) {
        case "slow-down": interval = Math.max(interval + 5, 1); break;
        case "expired": finish("expired", "The device code expired. Start sign-in again."); return;
        case "denied": finish("denied", "GitHub authorization was denied."); return;
        case "error": finish("error", result.message); return;
        default: break;
      }
      timer = setTimeout(tick, interval * 1000);
      activeTimers.add(timer);
    };
    timer = setTimeout(tick, interval * 1000);
    activeTimers.add(timer);
  };
  const authStatus = async () => {
    const raw = await resolveRawOAuthToken();
    if (raw === void 0) return {
      authenticated: false,
      credential: options().oauthTokenEnv,
      ...publicFlow(authFlow) ?? { state: "signed-out" }
    };
    const models = await catalog();
    return {
      authenticated: true,
      state: "authenticated",
      credential: options().oauthTokenEnv,
      modelCount: models.length,
      models: models.map((model) => ({ id: model.id, name: model.name ?? model.id }))
    };
  };
  const beginLogin = async () => {
    const existing = await resolveRawOAuthToken();
    if (existing !== void 0) return {
      authenticated: true,
      state: "authenticated",
      credential: options().oauthTokenEnv
    };
    if (authFlow?.state === "pending" && typeof authFlow.expiresAt === "number" && Date.now() < authFlow.expiresAt) {
      return { authenticated: false, ...publicFlow(authFlow) };
    }
    const device = await startDeviceFlow();
    schedulePoll(device);
    return { authenticated: false, ...publicFlow(authFlow) };
  };
  const logout = async () => {
    const ref = options().oauthTokenEnv;
    const credentials = ctx.get("credentials");
    if (credentials === void 0) throw new LlmError("GitHub Copilot sign-out needs the credentials service", "MISSING_CREDENTIAL");
    const existing = await resolveRawOAuthToken();
    authGeneration += 1;
    clearAuthTimers();
    authFlow = { state: "signed-out" };
    exchangeCache = void 0;
    catalogCache = void 0;
    // credentials.unset emits credentials/updated after its durable commit;
    // the shared listener refreshes model directories back to the fallback
    // catalog. An already-absent credential needs no additional announcement.
    if (existing !== void 0) await credentials.unset(ref);
    return { authenticated: false, state: "signed-out", credential: ref };
  };

  // ── Web settings API (optional; only mounted by the web profile) ──────────
  const sendJson = (res, status, body) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(JSON.stringify(body));
  };
  const webAction = (method, action) => async (req, res) => {
    if (req.method !== method) {
      res.setHeader("allow", method);
      sendJson(res, 405, { ok: false, error: `Use ${method}` });
      return;
    }
    try {
      sendJson(res, 200, { ok: true, value: await action() });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
  ctx.inject(["webServer"], (wctx) => {
    wctx.effect(() => {
      const disposers = [
        wctx.webServer.register({
          kind: "exact",
          path: "/github-copilot-auth/status",
          handler: webAction("GET", authStatus)
        }),
        wctx.webServer.register({
          kind: "exact",
          path: "/github-copilot-auth/login",
          handler: webAction("POST", beginLogin)
        }),
        wctx.webServer.register({
          kind: "exact",
          path: "/github-copilot-auth/logout",
          handler: webAction("POST", logout)
        })
      ];
      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    }, `${name}: Web OAuth routes`);
  });

  // ── slash commands (fallback for non-Web surfaces) ───────────────────────
  ctx.inject(["commands"], (cctx) => {
    cctx.commands.register({
      name: "copilot-login",
      description: "Sign in to GitHub Copilot via the device flow and register its models",
      handler: async () => {
        try {
          const status = await beginLogin();
          if (status.authenticated) return {
            kind: "success",
            text: `GitHub Copilot is already authenticated (credential ${options().oauthTokenEnv}). Run /copilot-status for details.`
          };
          return {
            kind: "success",
            text: [
              "GitHub Copilot sign-in",
              `1. Open this URL in your browser: ${status.verificationUri}`,
              `2. Enter this code: ${status.userCode}`,
              "3. Authorize the GitHub App (VS Code) and complete sign-in.",
              "",
              "Polling continues in the background; your token is stored automatically once you authorize. Check /copilot-status afterwards."
            ].join("\n")
          };
        } catch (error) {
          return { kind: "error", text: error instanceof Error ? error.message : String(error) };
        }
      }
    });
    cctx.commands.register({
      name: "copilot-status",
      description: "Show GitHub Copilot authentication and model status",
      handler: async () => {
        try {
          const status = await authStatus();
          if (!status.authenticated) return {
            kind: "success",
            text: `GitHub Copilot is NOT signed in. Run /copilot-login to sign in, or set ${options().oauthTokenEnv}.`
          };
          return {
            kind: "success",
            text: [
              `GitHub Copilot: authenticated (credential ${status.credential}).`,
              `Models available: ${status.modelCount}`,
              ...status.models.slice(0, 30).map((model) => `- ${model.id}`)
            ].join("\n")
          };
        } catch (error) {
          return { kind: "error", text: error instanceof Error ? error.message : String(error) };
        }
      }
    });
    cctx.commands.register({
      name: "copilot-logout",
      description: "Sign out of GitHub Copilot and remove the stored credential",
      handler: async () => {
        try {
          const existing = await resolveRawOAuthToken();
          const status = await logout();
          return {
            kind: "success",
            text: existing === void 0
              ? `GitHub Copilot is not signed in (no token found for ${status.credential}). Nothing to do.`
              : `GitHub Copilot signed out. Credential ${status.credential} has been removed. Run /copilot-login to sign in again.`
          };
        } catch (error) {
          return { kind: "error", text: error instanceof Error ? error.message : String(error) };
        }
      }
    });
  });
}
//#endregion

export { Config, DEFAULT_MODELS, DEFAULT_OAUTH_TOKEN_ENV, GitHubCopilotAdapter, apply, inject, name, readModelsListing, createImageResolver, serializeRequest, serializeResponsesRequest, translateResponses };
