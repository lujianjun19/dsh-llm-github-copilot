//#region attachment resolver
/**
 * Per-request image resolver for the GitHub Copilot adapter.
 *
 * One instance is created per outgoing request. It reads image bytes from the
 * AttachmentStore, validates each image against model-level vision limits, and
 * encodes the bytes as a data URI for the Provider wire payload.
 *
 * The resolver caches results by attachmentId so the same image that appears
 * in multiple history messages is read and Base64-encoded only once. Unique
 * image count is tracked to enforce model-level `maxImages` before any I/O.
 *
 * Design notes:
 * - The caller must pass a non-null attachmentStore when the request contains
 *   images; absence is an error (the adapter pre-flight check guarantees this
 *   in the normal path, but resolve() also defends against null explicitly).
 * - The storage-layer's verified mediaType is always used; the caller's claim
 *   in the ImageBlock is never trusted.
 * - No token, image content, or data URI is written to any log.
 * - The provided AbortSignal is forwarded to attachmentStore.readImage().
 */
function createImageResolver(attachmentStore, model, signal) {
  /** @type {Map<string, Promise<{ref: any, bytes: number, mediaType: string, dataUrl: string}>>} */
  const cache = new Map();
  let uniqueCount = 0;
  const vision = model?.vision;

  /**
   * Resolve one image reference to a data URI.
   * @param {import('@deepseek-ai/dsh-llm').ImageBlock['attachment']} ref
   */
  const resolve = (ref) => {
    const id = ref.attachmentId;
    const hit = cache.get(id);
    if (hit !== undefined) return hit;

    // Count new unique images and enforce the per-request limit before I/O.
    uniqueCount++;
    if (vision?.maxImages !== undefined && uniqueCount > vision.maxImages) {
      const limit = vision.maxImages;
      const promise = Promise.reject(new LlmError(
        `GitHub Copilot model "${model.id}" accepts at most ${limit} image${limit === 1 ? "" : "s"} per request; this request contains ${uniqueCount}.`,
        "UNSUPPORTED_CONTENT"
      ));
      // Register the rejection so the caller can surface it; prevent
      // unhandled-rejection noise if the caller does not immediately await.
      promise.catch(() => void 0);
      cache.set(id, promise);
      return promise;
    }

    const promise = (async () => {
      if (attachmentStore == null) {
        throw new LlmError(
          "GitHub Copilot image input requires the durable attachment service",
          "UNSUPPORTED_CONTENT"
        );
      }
      const stored = await attachmentStore.readImage(ref, signal);
      // Always use the storage-layer verified media type.
      const mediaType = stored.ref.mediaType;
      const byteLength = stored.data.byteLength;

      if (vision?.mediaTypes !== undefined && !vision.mediaTypes.includes(mediaType)) {
        throw new LlmError(
          `GitHub Copilot model "${model.id}" does not accept ${mediaType}.`,
          "UNSUPPORTED_CONTENT"
        );
      }
      if (vision?.maxImageBytes !== undefined && byteLength > vision.maxImageBytes) {
        throw new LlmError(
          `GitHub Copilot model "${model.id}" accepts images up to ${vision.maxImageBytes} bytes; this image is ${byteLength} bytes.`,
          "UNSUPPORTED_CONTENT"
        );
      }

      // Encode to data URI without logging the content.
      const dataUrl = `data:${mediaType};base64,${Buffer.from(stored.data).toString("base64")}`;
      return { ref: stored.ref, bytes: byteLength, mediaType, dataUrl };
    })();

    cache.set(id, promise);
    return promise;
  };

  return { resolve };
}
//#endregion
