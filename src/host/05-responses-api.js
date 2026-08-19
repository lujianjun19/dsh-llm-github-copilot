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

