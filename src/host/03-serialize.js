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

