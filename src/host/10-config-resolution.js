//#region config resolution
function resolveAdapterOptions(config, environment) {
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`${name}: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
  return {
    oauthTokenEnv: credentialRef(config.oauthTokenEnv ?? DEFAULT_OAUTH_TOKEN_ENV),
    baseURL: config.baseURL ?? void 0,
    models: (config.models ?? []).map((model) => {
      const hasImage = Array.isArray(model.inputModalities) && model.inputModalities.includes("image");
      return {
        id: model.id,
        ...model.name === void 0 ? {} : { name: model.name },
        ...model.description === void 0 ? {} : { description: model.description },
        ...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
        ...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
        // Pass through vision fields only when model explicitly declares image input.
        // Dynamic catalog from /models always sets inputModalities directly.
        inputModalities: hasImage ? ["text", "image"] : ["text"],
        ...hasImage && model.vision !== void 0 ? { vision: {
          ...model.vision.maxImageBytes !== void 0 ? { maxImageBytes: model.vision.maxImageBytes } : {},
          ...model.vision.maxImages !== void 0 ? { maxImages: model.vision.maxImages } : {},
          ...model.vision.mediaTypes !== void 0 ? { mediaTypes: model.vision.mediaTypes } : {},
          ...model.vision.imagePixelBudget !== void 0 ? { imagePixelBudget: model.vision.imagePixelBudget } : {}
        } } : {}
      };
    }),
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    defaultMaxTokens: config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    streamIdleTimeoutMs,
    imageOverflowPolicy: config.imageOverflowPolicy ?? DEFAULT_IMAGE_OVERFLOW_POLICY,
    defaultImagePixelBudget: config.defaultImagePixelBudget ?? DEFAULT_IMAGE_PIXEL_BUDGET,
    maxInlineRequestImageBytes: config.maxInlineRequestImageBytes ?? DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES,
    inlineImageOffloadByteQuantum: config.inlineImageOffloadByteQuantum ?? DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, `${name}: retryPolicy`)
  };
}
//#endregion

