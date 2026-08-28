//#region dsh-llm version compatibility
/**
 * Adapt the `@deepseek-ai/dsh-llm` APIs this adapter calls that changed shape
 * between Harness `0.1.1-rc.2` and `0.1.2-alpha.1`, and expose the one image
 * capability `0.1.2-alpha.1` added:
 *
 *   1. `CallId(id)` was renamed `ToolCallId(id)` (same runtime behaviour).
 *   2. `requestImageHandleText(version)` became
 *      `requestImageHandleText(ref, version, access?)`.
 *   3. `offloadRequestImagesWithPolicy()` replaced the fixed
 *      `OFFLOADED_IMAGE_TEXT` constant with a caller-supplied
 *      `policy.placeholder(ref)`, whose stock implementation is the newly
 *      exported `offloadedImageText(ref, access?)`.
 *   4. `resolveImageAttachmentAccess()` resolves one durable image to a
 *      read-only path in the tool execution world. Both (2) and (3) accept it
 *      as their optional `access` argument.
 *
 * The first three landed in the same release, so one feature probe selects the
 * whole calling convention rather than three independent guesses.
 * `offloadedImageText` is that probe: it exists only in the newer API and is
 * itself the replacement the new offload policy requires. (4) carries its own
 * probe, because it is an optional capability rather than a changed convention.
 *
 * @param {Record<string, unknown>} llm - the `@deepseek-ai/dsh-llm` namespace.
 * @returns {{ toolCallId: (id: string) => string,
 *             requestImageHandle: (ref: object, version: object, access?: object) => string,
 *             offloadPlaceholderFor: (resolveAccess?: Function) => object,
 *             imageAccess: (attachments: object, mapHostPath: Function, ref: object) => object | undefined }}
 */
function llmCompat(llm) {
  const perImageOffloadText = typeof llm.offloadedImageText === "function";
  const hasImageAccess = typeof llm.resolveImageAttachmentAccess === "function";
  return {
    /** Brand a provider-issued tool-call id. */
    toolCallId: llm.ToolCallId ?? llm.CallId,

    /** Model-visible handle printed beside one request image. */
    requestImageHandle: perImageOffloadText
      ? (ref, version, access) => llm.requestImageHandleText(ref, version, access)
      : (_ref, version) => llm.requestImageHandleText(version),

    /**
     * Policy fields carrying the model-visible replacement for an omitted
     * image, bound to the request's access resolution. Empty on the older API,
     * which owns that text itself.
     */
    offloadPlaceholderFor: perImageOffloadText
      ? (resolveAccess) => ({
        placeholder: (ref) => llm.offloadedImageText(ref, resolveAccess?.(ref))
      })
      : () => ({}),

    /**
     * Resolve one durable image to a read-only execution-world path, or
     * undefined when the harness, the attachment backend, or the filesystem
     * provider exposes no mapping.
     *
     * Failures are swallowed deliberately. The path only enriches
     * model-visible text, so a backend that rejects the lookup must degrade to
     * the pathless wording rather than fail the request. That matters most for
     * omitted images: their bytes are never read, so their durable reference is
     * never otherwise validated, and a throw here would turn a placeholder into
     * a failed request.
     */
    imageAccess: hasImageAccess
      ? (attachments, mapHostPath, ref) => {
        try {
          return llm.resolveImageAttachmentAccess(attachments, mapHostPath, ref);
        } catch {
          return void 0;
        }
      }
      : () => void 0
  };
}

/** Calling convention resolved once against the Harness actually loaded. */
const LLM = llmCompat(dshLlm);
//#endregion

