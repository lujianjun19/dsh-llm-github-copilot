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
//#endregion
