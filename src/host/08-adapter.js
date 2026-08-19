//#region adapter
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
    const body = await protocol.serialize(options, wire, imageResolver);
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

