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

