import z from "@deepseek-ai/schemastery";
import { CONTEXT_WINDOW_EXCEEDED_CODE, CallId, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE, RetryPolicySchema, assertUsableApiKey, attributionHeaders, contentHasImage, isContextWindowExceededError, isQuotaExceededError, offloadRequestImagesWithPolicy, requestImageHandleText, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
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

/** Request-image overflow strategy applied when Provider/local limits are exceeded. */
const DEFAULT_IMAGE_OVERFLOW_POLICY = "offload-oldest";

/** Default pixel budget per request image: 2048 × 2048. */
const DEFAULT_IMAGE_PIXEL_BUDGET = 4194304;

/** Default maximum total Base64 payload for all request images in one request (20 MiB). */
const DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;

/** Default byte quantum for inline image offload (10 MiB). */
const DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM = 10 * 1024 * 1024;

/** Default per-request-image maxBytes when the model does not publish a size limit (4 MiB). */
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

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
/** Vision limits for a static catalog model. */
const visionLimits = z.object({
  maxImageBytes: z.number().step(1).min(1),
  maxImages: z.number().step(1).min(1),
  mediaTypes: z.array(z.string()),
  imagePixelBudget: z.number().step(1).min(1)
});
const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  /** Accepted request modalities; omission means text-only. */
  inputModalities: z.array(z.union(["text", "image"])),
  /** Provider-level vision limits for this model (only valid with inputModalities including image). */
  vision: visionLimits
});
const Config = z.object({
  oauthTokenEnv: z.string().role("credential-ref").default(DEFAULT_OAUTH_TOKEN_ENV),
  baseURL: z.string(),
  models: z.array(catalogModel).default([]),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  /** Request-image overflow strategy. */
  imageOverflowPolicy: z.union(["offload-oldest", "error"]).default(DEFAULT_IMAGE_OVERFLOW_POLICY),
  /** Pixel budget for readImageRequest() when the model does not publish one. */
  defaultImagePixelBudget: z.number().step(1).min(1).default(DEFAULT_IMAGE_PIXEL_BUDGET),
  /** Maximum total Base64 request-image payload in one request. */
  maxInlineRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES),
  /** Byte removal quantum for inline offload. */
  inlineImageOffloadByteQuantum: z.number().step(1).min(1).default(DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM),
  retryPolicy: RetryPolicySchema
});
//#endregion

//#region serialize
/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks) {
  return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Reject image content in positions that do not support it (system/assistant). */
function assertTextOnly(blocks, position) {
  if (contentHasImage(blocks)) throw new LlmError(`GitHub Copilot adapter does not support image content in ${position} messages.`, "UNSUPPORTED_CONTENT");
}
/**
 * Serialize one user content block list that may contain images.
 * Pure-text content is returned as a plain string (preserving provider-cache
 * compatibility). Mixed or image-only content is returned as a content-part
 * array in OpenAI image_url format, preserving original block order.
 * Each image block is preceded by its stable handle text part.
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
      // Emit stable handle text BEFORE the image_url part.
      if (resolved?.handle) parts.push({ type: "text", text: resolved.handle });
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
/**
 * Serialize the conversation into OpenAI-compatible wire messages.
 *
 * Tool-result images are not carried inside role:tool messages (the wire
 * format does not support it). Instead, images from consecutive tool-result
 * messages are accumulated and flushed as a single role:user message that
 * immediately follows the run of role:tool messages.  Each image is preceded
 * by a call-id marker and its stable handle text.
 */
async function serializeMessages(messages, imageResolver) {
  const wire = [];
  // Buffer for images gathered from consecutive tool-result messages.
  // [{ callId, handle?, imageUrl }]
  let pendingToolImages = [];

  /** Flush accumulated tool images as one user message. */
  const flushToolImages = () => {
    if (pendingToolImages.length === 0) return;
    const content = [];
    for (const { callId, handle, imageUrl } of pendingToolImages) {
      content.push({ type: "text", text: `Image associated with tool call ${callId}:` });
      if (handle) content.push({ type: "text", text: handle });
      content.push({ type: "image_url", image_url: { url: imageUrl } });
    }
    wire.push({ role: "user", content });
    pendingToolImages = [];
  };

  for (const message of messages) {
    if (message.role === "system") {
      flushToolImages();
      assertTextOnly(message.content, "system");
      wire.push({ role: "system", content: flattenText(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      flushToolImages();
      assertTextOnly(message.content, "assistant");
      wire.push(serializeAssistant(message));
      continue;
    }
    // User messages: separate tool-result blocks from regular user content.
    const toolResults = message.content.filter((block) => block.type === "tool-result");
    const userBlocks = message.content.filter((block) => block.type !== "tool-result");

    if (toolResults.length > 0) {
      // Process each tool-result: text to role:tool, images to pending buffer.
      for (const result of toolResults) {
        wire.push({
          role: "tool",
          tool_call_id: result.toolCallId,
          content: flattenText(result.content) || "(no output)"
        });
        // Collect images from tool-result content (including nested tool-results).
        for (const block of result.content) {
          if (block.type === "image") {
            const resolved = await imageResolver.resolve(block.attachment);
            pendingToolImages.push({
              callId: result.toolCallId,
              handle: resolved?.handle,
              imageUrl: resolved.dataUrl
            });
          }
        }
      }
    }

    // Emit regular user content (if any).
    const text = flattenText(userBlocks);
    const hasImages = userBlocks.some((b) => b.type === "image");
    if (userBlocks.length > 0 && (text.length > 0 || hasImages)) {
      flushToolImages();
      const content = await serializeChatUserContent(userBlocks, imageResolver);
      wire.push({ role: "user", content });
    } else if (toolResults.length === 0) {
      // Pure user message with no content and no tool-results.
      flushToolImages();
      wire.push({ role: "user", content: "" });
    }
  }
  // Flush any remaining tool images after the last message.
  flushToolImages();
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
//#region block stream
/**
 * The Block stream: the shared, wire-agnostic assembler both translators drive.
 *
 * A **Block** is one unit of assistant output (text, reasoning, or tool-call)
 * with a `start → delta → end` lifecycle, mirroring the harness StreamChunk
 * vocabulary. This module owns index allocation, block ordering, lazy opening,
 * `block-start` / `*-delta` / `block-end` emission, and the terminal
 * usage/finish rule — everything that is identical across the chat-completions
 * and Responses wire formats.
 *
 * Wire-specific **routing** (chat keys tool calls by `call.index` in a Map;
 * Responses tracks a single reference because gpt-5.x rotates `item_id` per
 * event) stays in the translators. They hold the opaque tool handles this
 * module hands back and decide which handle a given wire event addresses.
 *
 * Interface shape: a reducer. Every method mutates internal block state and
 * *returns* the StreamChunks to emit; the translator does `yield* bs.text(d)`.
 * No method yields or performs I/O, so the whole module is unit-testable
 * through its interface without reconstructing an SSE byte stream.
 * @module dsh-llm-github-copilot/block-stream
 */
var BlockStream = class {
  #nextIndex = 0;
  #order = [];
  #text;
  #reasoning;

  #open(kind) {
    const block = { index: this.#nextIndex++, kind, text: "", closed: false };
    this.#order.push(block);
    return block;
  }

  #payload(block) {
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

  #end(block) {
    if (block.closed) return [];
    block.closed = true;
    return [{ type: "block-end", index: block.index, block: this.#payload(block) }];
  }

  /** True once at least one block has been opened — drives the empty-response rule. */
  get isEmpty() {
    return this.#order.length === 0;
  }

  /** Explicitly open the current text block (Responses content_part.added). Idempotent. */
  openText() {
    if (this.#text !== void 0 && !this.#text.closed) return [];
    this.#text = this.#open("text");
    return [{ type: "block-start", index: this.#text.index, blockType: "text" }];
  }

  /** Explicitly open the current reasoning block (Responses output_item.added). Idempotent. */
  openReasoning() {
    if (this.#reasoning !== void 0 && !this.#reasoning.closed) return [];
    this.#reasoning = this.#open("reasoning");
    return [{ type: "block-start", index: this.#reasoning.index, blockType: "reasoning" }];
  }

  /** Append a text delta, lazily opening the current text block. */
  text(delta) {
    const chunks = [];
    if (this.#text === void 0 || this.#text.closed) {
      this.#text = this.#open("text");
      chunks.push({ type: "block-start", index: this.#text.index, blockType: "text" });
    }
    this.#text.text += delta;
    chunks.push({ type: "text-delta", index: this.#text.index, text: delta });
    return chunks;
  }

  /** Append a reasoning delta, lazily opening the current reasoning block. */
  reasoning(delta) {
    const chunks = [];
    if (this.#reasoning === void 0 || this.#reasoning.closed) {
      this.#reasoning = this.#open("reasoning");
      chunks.push({ type: "block-start", index: this.#reasoning.index, blockType: "reasoning" });
    }
    this.#reasoning.text += delta;
    chunks.push({ type: "reasoning-delta", index: this.#reasoning.index, text: delta });
    return chunks;
  }

  /** True when a reasoning block is currently open (for `.done` backfill decisions). */
  get reasoningIsEmpty() {
    return this.#reasoning === void 0 || this.#reasoning.text.length === 0;
  }

  /** Close the current text block, if open. */
  closeText() {
    const block = this.#text;
    this.#text = void 0;
    return block === void 0 ? [] : this.#end(block);
  }

  /** Close the current reasoning block, if open. */
  closeReasoning() {
    const block = this.#reasoning;
    this.#reasoning = void 0;
    return block === void 0 ? [] : this.#end(block);
  }

  /** Open a tool-call block. Returns an opaque handle plus the block-start chunk. */
  openToolCall(meta) {
    const block = this.#open("tool-call");
    if (typeof meta?.name === "string") block.name = meta.name;
    if (typeof meta?.callId === "string") block.callId = meta.callId;
    return { handle: block, chunks: [{ type: "block-start", index: block.index, blockType: "tool-call" }] };
  }

  /** Append tool-call argument text on the handle, emitting a tool-call-delta. */
  toolArgs(handle, delta) {
    handle.text += delta;
    return [{
      type: "tool-call-delta",
      index: handle.index,
      id: CallId(handle.callId ?? ""),
      ...handle.name !== void 0 ? { name: handle.name } : {},
      argumentsDelta: delta
    }];
  }

  /**
   * Set authoritative metadata on a tool-call handle without emitting. Used for
   * the Responses `.done` full-arguments string and a late `call_id`. An
   * empty/absent `arguments` never clobbers already-captured argument text.
   */
  updateTool(handle, update) {
    if (typeof update?.name === "string") handle.name = update.name;
    if (typeof update?.callId === "string") handle.callId = update.callId;
    if (typeof update?.arguments === "string" && update.arguments.length > 0) handle.text = update.arguments;
  }

  /** Close a tool-call block by handle. Idempotent. */
  closeToolCall(handle) {
    return this.#end(handle);
  }

  /**
   * Terminal emit. Flushes any still-open blocks (in order), then `usage`, then
   * `finish`. The empty-response rule is unified: zero blocks produced and no
   * explicit `failure` yields the EMPTY_RESPONSE error, regardless of reason.
   */
  finish({ usage, reason, failure } = {}) {
    const chunks = [];
    for (const block of this.#order) chunks.push(...this.#end(block));
    if (usage !== void 0) chunks.push({ type: "usage", usage });
    if (failure !== void 0) {
      chunks.push({ type: "finish", reason: failure });
    } else if (this.isEmpty) {
      chunks.push({
        type: "finish",
        reason: {
          kind: "error",
          failure: { message: "model returned a completed response with no content", code: EMPTY_RESPONSE_CODE }
        }
      });
    } else {
      chunks.push({ type: "finish", reason: reason ?? { kind: "stop" } });
    }
    return chunks;
  }
};
//#endregion

//#region image request projection
/**
 * Per-request image projection for the GitHub Copilot adapter.
 *
 * Replaces the old createImageResolver approach. Two-phase pipeline:
 *
 *   Phase 1 — Conservative offload (no I/O):
 *     Identify protected images (last user-authored message + last tool batch).
 *     Use offloadRequestImagesWithPolicy with min(ref.bytes, maxBytes) estimates
 *     to drop the oldest eligible images before touching storage.
 *
 *   Phase 2 — Derive request images (parallel I/O):
 *     Call attachmentStore.readImageRequest() for each unique remaining ref.
 *     Validate derived MIME against model vision.mediaTypes.
 *
 *   Phase 3 — Exact offload:
 *     Re-run offload with actual base64 byte lengths.
 *     If any protected image would be dropped → throw UNSUPPORTED_CONTENT.
 *
 * The returned resolve(ref) function looks up by attachmentId. Offloaded images
 * return null; their placeholder text is already in the projected messages.
 *
 * @module dsh-llm-github-copilot/image-request-projection
 */

const BASE64_EXPANSION = (bytes) => Math.ceil(bytes / 3) * 4;

/** Collect all image AttachmentRefs by occurrence order (same id may appear multiple times). */
function collectImageOccurrences(messages) {
  const refs = [];
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "image") {
        refs.push(block.attachment);
      } else if (block.type === "tool-result") {
        for (const inner of block.content) {
          if (inner.type === "image") refs.push(inner.attachment);
        }
      }
    }
  }
  return refs;
}

/** Collect unique AttachmentRefs (by attachmentId) from projected messages for I/O. */
function collectUniqueRefs(messages) {
  const seen = new Map();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "image" && !seen.has(block.attachment.attachmentId)) {
        seen.set(block.attachment.attachmentId, block.attachment);
      } else if (block.type === "tool-result") {
        for (const inner of block.content) {
          if (inner.type === "image" && !seen.has(inner.attachment.attachmentId)) {
            seen.set(inner.attachment.attachmentId, inner.attachment);
          }
        }
      }
    }
  }
  return [...seen.values()];
}

/**
 * Identify protected attachmentIds that must not be dropped by offload-oldest.
 *
 * Protected set:
 *   1. Images from the last message with source.kind === "user"
 *      (the most recent human-authored turn).
 *   2. Images from the last consecutive run of source.kind === "tool" messages
 *      at the tail of the history (the latest tool-result batch).
 */
function identifyProtectedIds(messages) {
  const ids = new Set();

  // Last human-authored message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.source?.kind === "user") {
      for (const block of msg.content) {
        if (block.type === "image") ids.add(block.attachment.attachmentId);
      }
      break;
    }
  }

  // Last consecutive run of tool-result messages at the tail
  let lastToolIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].source?.kind === "tool") lastToolIdx = i;
    else break;
  }
  if (lastToolIdx >= 0) {
    for (let i = lastToolIdx; i < messages.length; i++) {
      for (const block of messages[i].content) {
        if (block.type === "tool-result") {
          for (const inner of block.content) {
            if (inner.type === "image") ids.add(inner.attachment.attachmentId);
          }
        }
      }
    }
  }

  return ids;
}

/**
 * Apply the overflow policy and return projected messages + a resolve function.
 *
 * @param {object} params
 * @param {readonly import('@deepseek-ai/dsh-llm').Message[]} params.messages
 * @param {object} params.model  - catalog entry (may have .vision limits)
 * @param {object | null | undefined} params.attachmentStore
 * @param {AbortSignal | undefined} params.signal
 * @param {string} params.overflowPolicy  - 'offload-oldest' | 'error'
 * @param {number} params.defaultImagePixelBudget
 * @param {number} params.maxInlineRequestImageBytes
 * @param {number} params.inlineImageOffloadByteQuantum
 * @param {{ warn(msg: string): void } | undefined} params.logger
 * @returns {Promise<{ messages: readonly Message[], resolve: Function, omitted: number }>}
 */
async function prepareRequestImages({
  messages,
  model,
  attachmentStore,
  signal,
  overflowPolicy,
  defaultImagePixelBudget,
  maxInlineRequestImageBytes,
  inlineImageOffloadByteQuantum,
  logger
}) {
  if (attachmentStore == null) {
    throw new LlmError(
      "GitHub Copilot image input requires the durable attachment service",
      "UNSUPPORTED_CONTENT"
    );
  }

  const vision = model?.vision;
  const requestPolicy = {
    maxPixels: vision?.imagePixelBudget ?? defaultImagePixelBudget,
    maxBytes: vision?.maxImageBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES
  };

  const protectedIds = identifyProtectedIds(messages);
  const allOccurrences = collectImageOccurrences(messages);

  // ── Strict mode: reject on any overflow ────────────────────────────────────
  if (overflowPolicy === "error") {
    const count = allOccurrences.length;
    if (vision?.maxImages !== undefined && count > vision.maxImages) {
      throw new LlmError(
        `GitHub Copilot model "${model.id}" image request exceeds maxImages=${vision.maxImages} while imageOverflowPolicy is "error".`,
        "UNSUPPORTED_CONTENT"
      );
    }
    // Byte check deferred to after readImageRequest (exact bytes)
  }

  // ── Check: current user submission alone must not exceed image count ────────
  // Count images only in the last human-authored message itself.
  const lastUserMsg = [...messages].reverse().find(m => m.source?.kind === "user");
  const currentUserImageCount = lastUserMsg ? collectImageOccurrences([lastUserMsg]).length : 0;
  if (vision?.maxImages !== undefined && currentUserImageCount > vision.maxImages) {
    throw new LlmError(
      `GitHub Copilot model "${model.id}" accepts at most ${vision.maxImages} image${vision.maxImages === 1 ? "" : "s"} per request; the current user message contains ${currentUserImageCount} protected images.`,
      "UNSUPPORTED_CONTENT"
    );
  }

  // ── Phase 1: conservative offload (no I/O) ──────────────────────────────────
  let projectedMessages = messages;
  if (overflowPolicy === "offload-oldest" && (vision?.maxImages !== undefined || maxInlineRequestImageBytes != null)) {
    projectedMessages = offloadRequestImagesWithPolicy(messages, {
      representation: "base64",
      maxImages: vision?.maxImages,
      maxBytes: maxInlineRequestImageBytes,
      byteQuantum: inlineImageOffloadByteQuantum,
      countQuantum: 1,
      byteLength: (ref) => BASE64_EXPANSION(Math.min(ref.bytes, requestPolicy.maxBytes))
    });

    // Verify protected images survived
    const keptIds = new Set(collectUniqueRefs(projectedMessages).map(r => r.attachmentId));
    for (const id of protectedIds) {
      if (!keptIds.has(id)) {
        throw new LlmError(
          `GitHub Copilot model "${model.id}" cannot retain protected images within the configured inline request budget.`,
          "UNSUPPORTED_CONTENT"
        );
      }
    }
  }

  // ── Phase 2: derive request images (parallel I/O) ─────────────────────────
  const uniqueRefs = collectUniqueRefs(projectedMessages);
  const requestImages = new Map(); // attachmentId → RequestImageAttachment

  await Promise.all(
    uniqueRefs.map(async (ref) => {
      const version = await attachmentStore.readImageRequest(ref, requestPolicy, signal);
      requestImages.set(ref.attachmentId, version);
    })
  );

  // Validate derived MIMEs
  if (vision?.mediaTypes !== undefined) {
    for (const [, version] of requestImages) {
      if (!vision.mediaTypes.includes(version.mediaType)) {
        throw new LlmError(
          `GitHub Copilot model "${model.id}" does not accept derived request image type ${version.mediaType}; accepted types: ${vision.mediaTypes.join(", ")}.`,
          "UNSUPPORTED_CONTENT"
        );
      }
    }
  }

  // ── Phase 3: exact offload using real base64 lengths ─────────────────────
  if (overflowPolicy === "offload-oldest") {
    projectedMessages = offloadRequestImagesWithPolicy(projectedMessages, {
      representation: "base64",
      maxImages: vision?.maxImages,
      maxBytes: maxInlineRequestImageBytes,
      byteQuantum: inlineImageOffloadByteQuantum,
      countQuantum: 1,
      byteLength: (ref) => {
        const version = requestImages.get(ref.attachmentId);
        return version != null ? BASE64_EXPANSION(version.bytes) : 0;
      }
    });

    // Verify protected images survived phase 3
    const keptIds3 = new Set(collectUniqueRefs(projectedMessages).map(r => r.attachmentId));
    for (const id of protectedIds) {
      if (!keptIds3.has(id)) {
        throw new LlmError(
          `GitHub Copilot model "${model.id}" cannot retain protected images within the configured inline request budget.`,
          "UNSUPPORTED_CONTENT"
        );
      }
    }
  }

  // ── Logging ────────────────────────────────────────────────────────────────
  const keptCount = collectImageOccurrences(projectedMessages).length;
  const omittedCount = allOccurrences.length - keptCount;
  if (omittedCount > 0 && logger != null) {
    const reason = vision?.maxImages !== undefined
      ? `maxImages=${vision.maxImages}`
      : `inline byte budget`;
    logger.warn(
      `GitHub Copilot model "${model.id}" omitted ${omittedCount} older request image${omittedCount === 1 ? "" : "s"} to satisfy ${reason}.`
    );
  }

  // ── Build resolve function ─────────────────────────────────────────────────
  const resolve = (ref) => {
    const version = requestImages.get(ref.attachmentId);
    if (version == null) return null; // was offloaded
    const dataUrl = `data:${version.mediaType};base64,${Buffer.from(version.data).toString("base64")}`;
    const handle = requestImageHandleText(version);
    return { version, dataUrl, handle, mediaType: version.mediaType };
  };

  return { messages: projectedMessages, resolve, omitted: omittedCount };
}
//#endregion
//#region sse translate
/**
 * Extract the reasoning text from a chat-completions delta, trying each field
 * in the order models have used them historically.
 * New field names need only be added here — translate() and traceSse() both
 * call this function and stay in sync automatically.
 */
function chatReasoningFrom(delta) {
  if (typeof delta?.reasoning_content === "string") return delta.reasoning_content;
  if (typeof delta?.reasoning_text === "string") return delta.reasoning_text;
  if (typeof delta?.reasoning === "string") return delta.reasoning;
  return "";
}
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
          const r = chatReasoningFrom(d);
          if (r.length > 0) fields.push(`reasoning=${len(r)}`);
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
/** Consume SSE data payloads and yield harness StreamChunks. */
async function* translate(payloads) {
  const blocks = new BlockStream();
  // Chat-completions routes tool calls by the wire's numeric `call.index`.
  const toolHandles = /* @__PURE__ */ new Map();
  let pendingFinish;
  let pendingFailure;
  let pendingUsage;
  for await (const payload of payloads) {
    if (payload === "[DONE]") {
      yield* blocks.finish({ usage: pendingUsage, reason: pendingFinish, failure: pendingFailure });
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
      const reasoning = chatReasoningFrom(delta);
      if (reasoning.length > 0) yield* blocks.reasoning(reasoning);
      const content = delta?.content;
      if (typeof content === "string" && content.length > 0) yield* blocks.text(content);
      for (const call of delta?.tool_calls ?? []) {
        let handle = toolHandles.get(call.index);
        if (handle === void 0) {
          const opened = blocks.openToolCall({ name: call.function?.name, callId: call.id });
          handle = opened.handle;
          toolHandles.set(call.index, handle);
          yield* opened.chunks;
        } else {
          blocks.updateTool(handle, { name: call.function?.name, callId: call.id });
        }
        yield* blocks.toolArgs(handle, call.function?.arguments ?? "");
      }
      if (typeof choice.finish_reason === "string") {
        // An error-kind finish reason is a wire failure: route it through the
        // failure slot so its specific message survives the empty-response rule.
        const mapped = mapFinishReason(choice.finish_reason);
        if (mapped.kind === "error") pendingFailure = mapped;
        else pendingFinish = mapped;
      }
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
  // Buffer for images from consecutive tool-result messages.
  let pendingToolImages = [];

  const flushToolImages = () => {
    if (pendingToolImages.length === 0) return;
    const content = [];
    for (const { callId, handle, imageUrl } of pendingToolImages) {
      content.push({ type: "input_text", text: `Image associated with tool call ${callId}:` });
      if (handle) content.push({ type: "input_text", text: handle });
      content.push({ type: "input_image", image_url: imageUrl });
    }
    input.push({ role: "user", content });
    pendingToolImages = [];
  };

  for (const message of messages) {
    if (message.role === "system") {
      flushToolImages();
      assertTextOnly(message.content, "system");
      input.push({ role: "system", content: [{ type: "input_text", text: flattenText(message.content) }] });
      continue;
    }
    if (message.role === "assistant") {
      flushToolImages();
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
    const userBlocks = message.content.filter((block) => block.type !== "tool-result");

    if (toolResults.length > 0) {
      // function_call_output: text only; images go to pendingToolImages.
      for (const result of toolResults) {
        input.push({
          type: "function_call_output",
          call_id: result.toolCallId,
          output: flattenText(result.content) || "(no output)"
        });
        for (const block of result.content) {
          if (block.type === "image") {
            const resolved = await imageResolver.resolve(block.attachment);
            pendingToolImages.push({
              callId: result.toolCallId,
              handle: resolved?.handle,
              imageUrl: resolved.dataUrl
            });
          }
        }
      }
    }

    const text = flattenText(userBlocks);
    const hasImages = userBlocks.some((b) => b.type === "image");
    if (userBlocks.length > 0 && (text.length > 0 || hasImages)) {
      flushToolImages();
      const contentParts = await serializeResponsesUserContent(userBlocks, imageResolver);
      input.push({ role: "user", content: contentParts });
    } else if (toolResults.length === 0) {
      flushToolImages();
      input.push({ role: "user", content: [{ type: "input_text", text: "" }] });
    }
  }
  flushToolImages();
  return input;
}
/**
 * Serialize one user content block list that may contain images for the
 * Responses API. Pure-text content produces a single input_text item;
 * mixed or image-only content produces an ordered array of input_text and
 * input_image items preserving the original block order.
 * Each image block is preceded by its stable handle text (input_text).
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
      // Emit stable handle text BEFORE the input_image part.
      if (resolved?.handle) parts.push({ type: "input_text", text: resolved.handle });
      parts.push({ type: "input_image", image_url: resolved.dataUrl });
    }
    // Reasoning and unknown block types are silently skipped.
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
  const blocks = new BlockStream();
  // gpt-5.x rotates a DIFFERENT opaque `item_id` across every event of one
  // logical item (output_item.added, *_text.delta, output_item.done all
  // differ), so id-based matching is impossible. Reasoning and tool-call items
  // stream strictly sequentially and never overlap, so a single tracked handle
  // per kind routes every delta and closes the block reliably. Text is likewise
  // a single open block at a time, owned inside BlockStream.
  let toolHandle;
  let finishReason;
  let usage;
  let failure;

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
          const opened = blocks.openToolCall({ name: item.name, callId: item.call_id });
          toolHandle = opened.handle;
          yield* opened.chunks;
        } else if (item?.type === "reasoning") {
          yield* blocks.openReasoning();
        }
        break;
      }
      case "response.content_part.added": {
        // Open the text block exactly once. Emitting block-start only when no
        // text block is open avoids both a missing block-start (first signal is
        // output_text.delta) and a duplicate (content_part.added after a delta).
        if (event.part?.type === "output_text") yield* blocks.openText();
        break;
      }
      case "response.output_text.delta": {
        // Some Copilot endpoints stream deltas without a preceding
        // content_part.added; text() lazily opens so the delta always addresses
        // an open block.
        yield* blocks.text(event.delta ?? "");
        break;
      }
      case "response.reasoning_summary_part.added": {
        // A reasoning item may contain multiple summary parts. Separate distinct
        // paragraphs with a blank line. The first part (empty block) needs none.
        if (!blocks.reasoningIsEmpty) yield* blocks.reasoning("\n\n");
        break;
      }
      // gpt-5.x (e.g. gpt-5.6 "luna") streams raw reasoning as
      // `reasoning_text.delta` rather than the summary variant. Handle BOTH so
      // the Think block receives content in either dialect; reasoning() lazily
      // opens so a delta arriving before output_item.added still streams.
      case "response.reasoning_text.delta":
      case "response.reasoning_summary_text.delta": {
        yield* blocks.reasoning(event.delta ?? "");
        break;
      }
      // Some endpoints send the complete reasoning only on the terminal `.done`
      // (full string in `event.text`) with no deltas. Backfill only when the
      // reasoning block is still empty, so deltas already streamed win.
      case "response.reasoning_text.done":
      case "response.reasoning_summary_text.done": {
        if (typeof event.text === "string" && event.text.length > 0 && blocks.reasoningIsEmpty) {
          yield* blocks.reasoning(event.text);
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        if (toolHandle === void 0) {
          const opened = blocks.openToolCall();
          toolHandle = opened.handle;
          yield* opened.chunks;
        }
        yield* blocks.toolArgs(toolHandle, event.delta ?? "");
        break;
      }
      case "response.function_call_arguments.done": {
        // `arguments` here is the authoritative complete JSON string; the delta
        // stream only forwards the opening/closing quotes on some endpoints.
        if (toolHandle !== void 0) blocks.updateTool(toolHandle, { arguments: event.arguments });
        break;
      }
      case "response.output_item.done": {
        const item = event.item;
        if (item?.type === "message") {
          yield* blocks.closeText();
        } else if (item?.type === "function_call" && toolHandle !== void 0) {
          // item.arguments here is the authoritative complete JSON string; an
          // empty/absent value must not clobber args already captured.
          blocks.updateTool(toolHandle, { name: item.name, callId: item.call_id, arguments: item.arguments });
          yield* blocks.closeToolCall(toolHandle);
          toolHandle = void 0;
        } else if (item?.type === "reasoning") {
          yield* blocks.closeReasoning();
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
  // BlockStream.finish flushes any still-open blocks (defensive), emits usage
  // before finish, and applies the unified empty-response rule.
  yield* blocks.finish({ usage, reason: finishReason, failure });
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

//#region wire protocol
/**
 * Wire-protocol adapters for the two GitHub transports.
 *
 * A **Wire protocol** encapsulates the full I/O contract of one GitHub endpoint:
 * the path to POST to, the serializer that builds the request body, and the
 * translator that consumes the SSE response into harness StreamChunks. The
 * adapter's request() method selects one protocol object and then speaks only
 * to this interface — path/serialize/translate can no longer drift apart.
 *
 * Interface: { path: string, serialize, translate }
 *   serialize(options, wire, imageResolver) → Promise<object>  (request body)
 *   translate(responseBody)                → AsyncIterable<StreamChunk>
 *
 * @module dsh-llm-github-copilot/wire-protocol
 */

/** Chat-completions wire protocol — POST /chat/completions. */
function chatProtocol() {
  return {
    path: "/chat/completions",
    serialize: (options, wire, imageResolver) =>
      serializeRequest(options, wire, imageResolver),
    translate: (body) =>
      translate(traceSse(parseSse(body), "chat"))
  };
}

/**
 * Responses-API wire protocol — POST /responses.
 * @param {boolean} supportsReasoning  Whether the model exposes reasoning effort
 *   (decides whether to include `reasoning.summary` in the wire request).
 */
function responsesProtocol(supportsReasoning) {
  return {
    path: "/responses",
    serialize: (options, wire, imageResolver) =>
      serializeResponsesRequest(options, wire, imageResolver, supportsReasoning),
    translate: (body) =>
      translateResponses(traceSse(parseSse(body, false), "responses"))
  };
}

/**
 * Select the wire protocol for a model catalog entry.
 * Prefers the Responses API whenever the model advertises it — gpt-5.x models
 * that advertise BOTH endpoints hide their reasoning on /chat/completions (the
 * stream reports reasoning_tokens in usage but never streams the text), while
 * on /responses the same models emit reasoning_summary_text / reasoning_text
 * deltas, restoring live Think content.
 */
function selectProtocol(entry) {
  const endpoints = entry?.endpoints;
  const supportsReasoning = reasoningMetadata(entry) !== void 0;
  return Array.isArray(endpoints) && endpoints.includes("/responses")
    ? responsesProtocol(supportsReasoning)
    : chatProtocol();
}
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
//#endregion
//#region adapter
/** A no-op resolver used for text-only requests to satisfy the serialize signature. */
const noopImageResolver = { resolve: () => Promise.reject(new LlmError("unexpected image in text-only request", "UNSUPPORTED_CONTENT")) };
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
    const protocol = selectProtocol(entry);
    const wire = wireReasoning(entry, options.reasoningEffort);
    // Image pre-flight: gate model capability and attachment-service presence
    // before doing any I/O. Text-only requests skip this entirely.
    const containsImage = options.messages.some((m) => contentHasImage(m.content));
    let projection = null;
    if (containsImage) {
      const modalities = entry?.inputModalities ?? ["text"];
      if (!modalities.includes("image")) {
        throw new LlmError(
          `GitHub Copilot model "${options.model}" does not support image input.`,
          "UNSUPPORTED_CONTENT"
        );
      }
      const attachmentStore = this.config.resolveAttachments();
      if (attachmentStore == null) {
        throw new LlmError(
          "GitHub Copilot image input requires the durable attachment service",
          "UNSUPPORTED_CONTENT"
        );
      }
      const adapterOptions = this.config.options();
      projection = await prepareRequestImages({
        messages: options.messages,
        model: entry,
        attachmentStore,
        signal,
        overflowPolicy: adapterOptions.imageOverflowPolicy,
        defaultImagePixelBudget: adapterOptions.defaultImagePixelBudget,
        maxInlineRequestImageBytes: adapterOptions.maxInlineRequestImageBytes,
        inlineImageOffloadByteQuantum: adapterOptions.inlineImageOffloadByteQuantum,
        logger: this.config.warn != null ? { warn: this.config.warn } : void 0
      });
    }
    // Build request options with projected messages (offloaded images replaced)
    const requestOptions = projection != null
      ? { ...options, messages: projection.messages }
      : options;
    const body = await protocol.serialize(requestOptions, wire, projection ?? noopImageResolver);
    const payload = JSON.stringify(body);
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
      response = await copilotFetch(`${connection.baseUrl}${protocol.path}`, {
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
    yield* protocol.translate(response.body);
  }
};
//#endregion

//#region model discovery
/** Whether a Copilot model is served by an endpoint this adapter speaks (/chat/completions or /responses). */
function isServedByAdapter(raw) {
  // GitHub Copilot's own clients (VS Code, etc.) hide models where
  // model_picker_enabled is explicitly false — these are legacy versioned
  // snapshots (e.g. gpt-4o-2024-08-06) that share a display name with the
  // canonical alias (gpt-4o) and are the direct cause of duplicate entries in
  // the DSH model picker.  Absent means the field is not yet declared, which
  // we treat as enabled to stay forward-compatible.
  if (raw?.model_picker_enabled === false) return false;
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
    models: (config.models ?? []).map((model) => {
      const hasImage = Array.isArray(model.inputModalities) && model.inputModalities.includes("image");
      return {
        id: model.id,
        ...model.name === void 0 ? {} : { name: model.name },
        ...model.description === void 0 ? {} : { description: model.description },
        ...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
        ...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
        // Pass through vision fields only when model explicitly declares image input.
        // Dynamic catalog from /models always sets inputModalities directly.
        inputModalities: hasImage ? ["text", "image"] : ["text"],
        ...hasImage && model.vision !== void 0 ? { vision: {
          ...model.vision.maxImageBytes !== void 0 ? { maxImageBytes: model.vision.maxImageBytes } : {},
          ...model.vision.maxImages !== void 0 ? { maxImages: model.vision.maxImages } : {},
          ...model.vision.mediaTypes !== void 0 ? { mediaTypes: model.vision.mediaTypes } : {},
          ...model.vision.imagePixelBudget !== void 0 ? { imagePixelBudget: model.vision.imagePixelBudget } : {}
        } } : {}
      };
    }),
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    defaultMaxTokens: config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    streamIdleTimeoutMs,
    imageOverflowPolicy: config.imageOverflowPolicy ?? DEFAULT_IMAGE_OVERFLOW_POLICY,
    defaultImagePixelBudget: config.defaultImagePixelBudget ?? DEFAULT_IMAGE_PIXEL_BUDGET,
    maxInlineRequestImageBytes: config.maxInlineRequestImageBytes ?? DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES,
    inlineImageOffloadByteQuantum: config.inlineImageOffloadByteQuantum ?? DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM,
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
    resolveAttachments: () => ctx.get("attachments"),
    warn: (msg) => ctx.logger.warn(msg)
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

export { BlockStream, Config, DEFAULT_MODELS, DEFAULT_OAUTH_TOKEN_ENV, GitHubCopilotAdapter, apply, inject, name, readModelsListing, createImageResolver, prepareRequestImages, serializeRequest, serializeResponsesRequest, translate, translateResponses };
