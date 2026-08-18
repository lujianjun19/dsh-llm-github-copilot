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
  // When no effort is explicitly selected, omit the effort field and let the
  // API apply its own default; only the summary key is required to unlock the
  // streaming events.
  const reasoningParam = supportsReasoning
    ? { reasoning: { ...(wire !== void 0 ? { effort: wire.value } : {}), summary: "concise" } }
    : wire !== void 0 ? { reasoning: { effort: wire.value, summary: "concise" } }
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
  const ensureText = () => {
    if (textBlock === void 0) textBlock = open("text");
    return textBlock;
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
        if (event.part?.type === "output_text") {
          const block = ensureText();
          yield { type: "block-start", index: block.index, blockType: "text" };
        }
        break;
      }
      case "response.output_text.delta": {
        const block = ensureText();
        block.text += event.delta ?? "";
        yield { type: "text-delta", index: block.index, text: event.delta ?? "" };
        break;
      }
      case "response.reasoning_summary_part.added": {
        // A reasoning item may contain multiple summary parts. Insert a blank
        // line between parts so distinct summary paragraphs stay separated in
        // the Think block. The first part (empty block) needs no separator.
        const block = reasoningBlock ?? order.find((b) => b.kind === "reasoning" && !b._closed);
        if (block !== void 0 && block.text.length > 0) {
          block.text += "\n\n";
          yield { type: "reasoning-delta", index: block.index, text: "\n\n" };
        }
        break;
      }
      case "response.reasoning_summary_text.delta": {
        // Route by the current open reasoning block, NOT by event.item_id:
        // Copilot's gpt-5.x stream gives every event a distinct opaque id, so a
        // map lookup on item_id never hits. Fall back to the last open reasoning
        // block for resilience.
        const block = reasoningBlock ?? order.find((b) => b.kind === "reasoning" && !b._closed);
        if (block !== void 0) {
          block.text += event.delta ?? "";
          yield { type: "reasoning-delta", index: block.index, text: event.delta ?? "" };
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const block = toolBlocks.get(event.item_id ?? "");
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
        const block = toolBlocks.get(event.item_id ?? "");
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
          const block = toolBlocks.get(item.id ?? "");
          if (block !== void 0) {
            if (typeof item.name === "string") block.name = item.name;
            if (typeof item.call_id === "string") block.callId = item.call_id;
            // Only overwrite with a non-empty value: an empty/absent `arguments`
            // here must not clobber arguments already captured from
            // `response.function_call_arguments.done` (or the delta stream).
            if (typeof item.arguments === "string" && item.arguments.length > 0) block.text = item.arguments;
            block._closed = true;
            yield { type: "block-end", index: block.index, block: close(block) };
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

