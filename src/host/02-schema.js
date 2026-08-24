//#region schema
/** Vision limits for a static catalog model. */
const visionLimits = z.object({
  maxImageBytes: z.number().step(1).min(1),
  maxImages: z.number().step(1).min(1),
  mediaTypes: z.array(z.string()),
  imagePixelBudget: z.number().step(1).min(1)
});
const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  /** Accepted request modalities; omission means text-only. */
  inputModalities: z.array(z.union(["text", "image"])),
  /** Provider-level vision limits for this model (only valid with inputModalities including image). */
  vision: visionLimits
});
const Config = z.object({
  oauthTokenEnv: z.string().role("credential-ref").default(DEFAULT_OAUTH_TOKEN_ENV),
  baseURL: z.string(),
  models: z.array(catalogModel).default([]),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  /** Request-image overflow strategy. */
  imageOverflowPolicy: z.union(["offload-oldest", "error"]).default(DEFAULT_IMAGE_OVERFLOW_POLICY),
  /** Pixel budget for readImageRequest() when the model does not publish one. */
  defaultImagePixelBudget: z.number().step(1).min(1).default(DEFAULT_IMAGE_PIXEL_BUDGET),
  /** Maximum total Base64 request-image payload in one request. */
  maxInlineRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES),
  /** Byte removal quantum for inline offload. */
  inlineImageOffloadByteQuantum: z.number().step(1).min(1).default(DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM),
  retryPolicy: RetryPolicySchema
});
//#endregion

