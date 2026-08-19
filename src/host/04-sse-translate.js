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

