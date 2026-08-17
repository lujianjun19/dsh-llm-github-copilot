//#region model discovery
/** Whether a Copilot model is served by an endpoint this adapter speaks (/chat/completions or /responses). */
function isServedByAdapter(raw) {
  // Non-chat capabilities (e.g. embeddings) are never served by either endpoint.
  const type = raw?.capabilities?.type;
  if (type !== void 0 && type !== "chat") return false;
  // Internal routing models carry no user-facing meaning.
  if (typeof raw?.id === "string" && raw.id.includes("compaction")) return false;
  const endpoints = raw?.supported_endpoints;
  if (Array.isArray(endpoints) && endpoints.length > 0) {
    return endpoints.includes("/chat/completions") || endpoints.includes("/responses");
  }
  return true; // legacy models with no declared endpoints are chat/completions models
}
function readModelsListing(body) {
  const data = body?.data;
  if (!Array.isArray(data)) return void 0;
  const models = [];
  for (const raw of data) {
    const id = raw?.id;
    if (typeof id !== "string" || id.length === 0) continue;
    if (!isServedByAdapter(raw)) continue;
    const entry = { id };
    if (typeof raw?.name === "string" && raw.name.length > 0) entry.name = raw.name;
    else if (typeof raw?.display_name === "string" && raw.display_name.length > 0) entry.name = raw.display_name;
    const limits = raw?.capabilities?.limits;
    const contextWindow = limits?.max_context_window_tokens ?? raw?.context_window ?? raw?.context_length;
    if (typeof contextWindow === "number" && Number.isInteger(contextWindow) && contextWindow > 0) entry.contextWindow = contextWindow;
    const maxTokens = limits?.max_output_tokens ?? raw?.max_output_tokens ?? raw?.max_tokens;
    if (typeof maxTokens === "number" && Number.isInteger(maxTokens) && maxTokens > 0) entry.maxTokens = maxTokens;
    if (Array.isArray(raw?.supported_endpoints) && raw.supported_endpoints.length > 0) entry.endpoints = raw.supported_endpoints;
    // Per-model reasoning definition: the endpoint declares exactly which
    // reasoning-effort levels a model supports (gpt-5.x / gemini / kimi), while
    // Claude-family models expose a thinking budget instead of effort levels.
    const supports = raw?.capabilities?.supports;
    const reasoningEffort = supports?.reasoning_effort;
    if (Array.isArray(reasoningEffort) && reasoningEffort.length > 0) entry.reasoningEffort = reasoningEffort;
    const minBudget = supports?.min_thinking_budget;
    const maxBudget = supports?.max_thinking_budget;
    if (Number.isFinite(minBudget) || Number.isFinite(maxBudget)) entry.thinkingBudgets = {
      ...Number.isFinite(minBudget) ? { min: minBudget } : {},
      ...Number.isFinite(maxBudget) ? { max: maxBudget } : {}
    };
    // Vision capability: only declare image modality when the endpoint explicitly
    // reports supports.vision === true. Never infer from model name or family.
    if (supports?.vision === true) {
      entry.inputModalities = ["text", "image"];
      const vl = limits?.vision;
      if (vl !== null && typeof vl === "object") {
        const vision = {};
        const rawBytes = vl.max_prompt_image_size;
        if (typeof rawBytes === "number" && Number.isInteger(rawBytes) && rawBytes > 0) vision.maxImageBytes = rawBytes;
        const rawImages = vl.max_prompt_images;
        if (typeof rawImages === "number" && Number.isInteger(rawImages) && rawImages > 0) vision.maxImages = rawImages;
        const rawTypes = vl.supported_media_types;
        if (Array.isArray(rawTypes)) {
          const types = [...new Set(rawTypes.filter((t) => typeof t === "string" && t.length > 0))];
          if (types.length > 0) vision.mediaTypes = types;
        }
        if (Object.keys(vision).length > 0) entry.vision = vision;
      }
    } else {
      entry.inputModalities = ["text"];
    }
    models.push(entry);
  }
  return models.length > 0 ? models : void 0;
}
//#endregion

