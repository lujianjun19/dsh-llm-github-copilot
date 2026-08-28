//#region dsh-llm version compatibility
/**
 * Adapt the three `@deepseek-ai/dsh-llm` APIs this adapter calls that changed
 * shape between Harness `0.1.1-rc.2` and `0.1.2-alpha.1`:
 *
 *   1. `CallId(id)` was renamed `ToolCallId(id)` (same runtime behaviour).
 *   2. `requestImageHandleText(version)` became
 *      `requestImageHandleText(ref, version, access?)`.
 *   3. `offloadRequestImagesWithPolicy()` replaced the fixed
 *      `OFFLOADED_IMAGE_TEXT` constant with a caller-supplied
 *      `policy.placeholder(ref)`, whose stock implementation is the newly
 *      exported `offloadedImageText(ref, access?)`.
 *
 * All three landed in the same release, so one feature probe selects the whole
 * calling convention rather than three independent guesses. `offloadedImageText`
 * is the probe because it exists only in the newer API and is itself the
 * replacement the new offload policy requires.
 *
 * @param {Record<string, unknown>} llm - the `@deepseek-ai/dsh-llm` namespace.
 * @returns {{ toolCallId: (id: string) => string,
 *             requestImageHandle: (ref: object, version: object) => string,
 *             offloadPlaceholder: object }}
 */
function llmCompat(llm) {
  const perImageOffloadText = typeof llm.offloadedImageText === "function";
  return {
    /** Brand a provider-issued tool-call id. */
    toolCallId: llm.ToolCallId ?? llm.CallId,
    /** Model-visible handle printed beside one request image. */
    requestImageHandle: perImageOffloadText
      ? (ref, version) => llm.requestImageHandleText(ref, version)
      : (_ref, version) => llm.requestImageHandleText(version),
    /**
     * Policy fields carrying the model-visible replacement for an omitted
     * image. Empty on the older API, which owns that text itself.
     */
    offloadPlaceholder: perImageOffloadText ? { placeholder: llm.offloadedImageText } : {}
  };
}

/** Calling convention resolved once against the Harness actually loaded. */
const LLM = llmCompat(dshLlm);
//#endregion

