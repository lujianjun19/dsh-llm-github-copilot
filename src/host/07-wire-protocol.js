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
