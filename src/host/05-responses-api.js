//#region responses api
/**
 * OpenAI Responses-API serialization + translation for models GitHub serves
 * only through `/responses` (the gpt-5.x family: gpt-5.4-mini, gpt-5.5,
 * gpt-5.6-*). The wire vocabulary mirrors the chat-completions adapter but
 * with Responses input items and streaming events.
 * @module dsh-llm-github-copilot/responses
 */
/** Serialize the conversation into Responses `input` items. */
function serializeResponsesMessages(messages) {
  const input = [];
  for (const message of messages) {
    assertTextOnly(message.content);
    if (message.role === "system") {
      input.push({ role: "system", content: [{ type: "input_text", text: flattenText(message.content) }] });
      continue;
    }
    if (message.role === "assistant") {
      const text = flattenText(message.content);
      const toolCalls = message.content.filter((block) => block.type === "tool-call").map((block) => ({
        type: "output_tool_call",
        call_id: block.id,
        name: block.name,
        arguments: block.arguments
      }));
      input.push({
        role: "assistant",
        content: [
          ...text.length > 0 ? [{ type: "output_text", text }] : [],
          ...toolCalls
        ]
      });
      continue;
    }
    const toolResults = message.content.filter((block) => block.type === "tool-result");
    const text = flattenText(message.content);
    if (text.length > 0 || toolResults.length === 0) input.push({ role: "user", content: [{ type: "input_text", text: text || "" }] });
    for (const result of toolResults) input.push({
      type: "function_call_output",
      call_id: result.toolCallId,
      output: flattenText(result.content) || "(no output)"
    });
  }
  return input;
}
/** Build the full Responses wire request body. */
function serializeResponsesRequest(options, wire) {
  const input = serializeResponsesMessages(options.messages);
  if (options.system !== void 0) input.unshift({ role: "system", content: [{ type: "input_text", text: options.system }] });
  const tools = options.tools?.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
  return {
    model: options.model,
    input,
    stream: true,
    ...tools !== void 0 && tools.length > 0 ? { tools } : {},
    ...options.temperature !== void 0 ? { temperature: options.temperature } : {},
    ...options.maxTokens === void 0 ? {} : { max_output_tokens: options.maxTokens },
    ...options.stop !== void 0 ? { stop: options.stop } : {},
    ...wire === void 0 ? {} : { reasoning: { effort: wire.value } }
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
      case "response.reasoning_summary_text.delta": {
        const block = reasoningBlocks.get(event.item_id ?? "") ?? order.find((b) => b.kind === "reasoning" && !b._closed);
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
            if (typeof item.arguments === "string") block.text = item.arguments;
            block._closed = true;
            yield { type: "block-end", index: block.index, block: close(block) };
            toolBlocks.delete(item.id ?? "");
          }
        } else if (item?.type === "reasoning") {
          const block = reasoningBlocks.get(item.id ?? "");
          if (block !== void 0) {
            block._closed = true;
            yield { type: "block-end", index: block.index, block: { type: "reasoning", text: block.text } };
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

