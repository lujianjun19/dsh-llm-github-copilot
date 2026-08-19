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

