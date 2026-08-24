//#region image request projection
/**
 * Per-request image projection for the GitHub Copilot adapter.
 *
 * Replaces the old createImageResolver approach. Two-phase pipeline:
 *
 *   Phase 1 — Conservative offload (no I/O):
 *     Identify protected images (last user-authored message + last tool batch).
 *     Use offloadRequestImagesWithPolicy with min(ref.bytes, maxBytes) estimates
 *     to drop the oldest eligible images before touching storage.
 *
 *   Phase 2 — Derive request images (parallel I/O):
 *     Call attachmentStore.readImageRequest() for each unique remaining ref.
 *     Validate derived MIME against model vision.mediaTypes.
 *
 *   Phase 3 — Exact offload:
 *     Re-run offload with actual base64 byte lengths.
 *     If any protected image would be dropped → throw UNSUPPORTED_CONTENT.
 *
 * The returned resolve(ref) function looks up by attachmentId. Offloaded images
 * return null; their placeholder text is already in the projected messages.
 *
 * @module dsh-llm-github-copilot/image-request-projection
 */

const BASE64_EXPANSION = (bytes) => Math.ceil(bytes / 3) * 4;

/** Collect all image AttachmentRefs by occurrence order (same id may appear multiple times). */
function collectImageOccurrences(messages) {
  const refs = [];
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "image") {
        refs.push(block.attachment);
      } else if (block.type === "tool-result") {
        for (const inner of block.content) {
          if (inner.type === "image") refs.push(inner.attachment);
        }
      }
    }
  }
  return refs;
}

/** Collect unique AttachmentRefs (by attachmentId) from projected messages for I/O. */
function collectUniqueRefs(messages) {
  const seen = new Map();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "image" && !seen.has(block.attachment.attachmentId)) {
        seen.set(block.attachment.attachmentId, block.attachment);
      } else if (block.type === "tool-result") {
        for (const inner of block.content) {
          if (inner.type === "image" && !seen.has(inner.attachment.attachmentId)) {
            seen.set(inner.attachment.attachmentId, inner.attachment);
          }
        }
      }
    }
  }
  return [...seen.values()];
}

/**
 * Identify protected attachmentIds that must not be dropped by offload-oldest.
 *
 * Protected set:
 *   1. Images from the last message with source.kind === "user"
 *      (the most recent human-authored turn).
 *   2. Images from the last consecutive run of source.kind === "tool" messages
 *      at the tail of the history (the latest tool-result batch).
 */
function identifyProtectedIds(messages) {
  const ids = new Set();

  // Last human-authored message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.source?.kind === "user") {
      for (const block of msg.content) {
        if (block.type === "image") ids.add(block.attachment.attachmentId);
      }
      break;
    }
  }

  // Last consecutive run of tool-result messages at the tail
  let lastToolIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].source?.kind === "tool") lastToolIdx = i;
    else break;
  }
  if (lastToolIdx >= 0) {
    for (let i = lastToolIdx; i < messages.length; i++) {
      for (const block of messages[i].content) {
        if (block.type === "tool-result") {
          for (const inner of block.content) {
            if (inner.type === "image") ids.add(inner.attachment.attachmentId);
          }
        }
      }
    }
  }

  return ids;
}

/**
 * Apply the overflow policy and return projected messages + a resolve function.
 *
 * @param {object} params
 * @param {readonly import('@deepseek-ai/dsh-llm').Message[]} params.messages
 * @param {object} params.model  - catalog entry (may have .vision limits)
 * @param {object | null | undefined} params.attachmentStore
 * @param {AbortSignal | undefined} params.signal
 * @param {string} params.overflowPolicy  - 'offload-oldest' | 'error'
 * @param {number} params.defaultImagePixelBudget
 * @param {number} params.maxInlineRequestImageBytes
 * @param {number} params.inlineImageOffloadByteQuantum
 * @param {{ warn(msg: string): void } | undefined} params.logger
 * @returns {Promise<{ messages: readonly Message[], resolve: Function, omitted: number }>}
 */
async function prepareRequestImages({
  messages,
  model,
  attachmentStore,
  signal,
  overflowPolicy,
  defaultImagePixelBudget,
  maxInlineRequestImageBytes,
  inlineImageOffloadByteQuantum,
  logger
}) {
  if (attachmentStore == null) {
    throw new LlmError(
      "GitHub Copilot image input requires the durable attachment service",
      "UNSUPPORTED_CONTENT"
    );
  }

  const vision = model?.vision;
  const requestPolicy = {
    maxPixels: vision?.imagePixelBudget ?? defaultImagePixelBudget,
    maxBytes: vision?.maxImageBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES
  };

  const protectedIds = identifyProtectedIds(messages);
  const allOccurrences = collectImageOccurrences(messages);

  // ── Strict mode: reject on any overflow ────────────────────────────────────
  if (overflowPolicy === "error") {
    const count = allOccurrences.length;
    if (vision?.maxImages !== undefined && count > vision.maxImages) {
      throw new LlmError(
        `GitHub Copilot model "${model.id}" image request exceeds maxImages=${vision.maxImages} while imageOverflowPolicy is "error".`,
        "UNSUPPORTED_CONTENT"
      );
    }
    // Byte check deferred to after readImageRequest (exact bytes)
  }

  // ── Check: current user submission alone must not exceed image count ────────
  // Count images only in the last human-authored message itself.
  const lastUserMsg = [...messages].reverse().find(m => m.source?.kind === "user");
  const currentUserImageCount = lastUserMsg ? collectImageOccurrences([lastUserMsg]).length : 0;
  if (vision?.maxImages !== undefined && currentUserImageCount > vision.maxImages) {
    throw new LlmError(
      `GitHub Copilot model "${model.id}" accepts at most ${vision.maxImages} image${vision.maxImages === 1 ? "" : "s"} per request; the current user message contains ${currentUserImageCount} protected images.`,
      "UNSUPPORTED_CONTENT"
    );
  }

  // ── Phase 1: conservative offload (no I/O) ──────────────────────────────────
  let projectedMessages = messages;
  if (overflowPolicy === "offload-oldest" && (vision?.maxImages !== undefined || maxInlineRequestImageBytes != null)) {
    projectedMessages = offloadRequestImagesWithPolicy(messages, {
      representation: "base64",
      maxImages: vision?.maxImages,
      maxBytes: maxInlineRequestImageBytes,
      byteQuantum: inlineImageOffloadByteQuantum,
      countQuantum: 1,
      byteLength: (ref) => BASE64_EXPANSION(Math.min(ref.bytes, requestPolicy.maxBytes))
    });

    // Verify protected images survived
    const keptIds = new Set(collectUniqueRefs(projectedMessages).map(r => r.attachmentId));
    for (const id of protectedIds) {
      if (!keptIds.has(id)) {
        throw new LlmError(
          `GitHub Copilot model "${model.id}" cannot retain protected images within the configured inline request budget.`,
          "UNSUPPORTED_CONTENT"
        );
      }
    }
  }

  // ── Phase 2: derive request images (parallel I/O) ─────────────────────────
  const uniqueRefs = collectUniqueRefs(projectedMessages);
  const requestImages = new Map(); // attachmentId → RequestImageAttachment

  await Promise.all(
    uniqueRefs.map(async (ref) => {
      const version = await attachmentStore.readImageRequest(ref, requestPolicy, signal);
      requestImages.set(ref.attachmentId, version);
    })
  );

  // Validate derived MIMEs
  if (vision?.mediaTypes !== undefined) {
    for (const [, version] of requestImages) {
      if (!vision.mediaTypes.includes(version.mediaType)) {
        throw new LlmError(
          `GitHub Copilot model "${model.id}" does not accept derived request image type ${version.mediaType}; accepted types: ${vision.mediaTypes.join(", ")}.`,
          "UNSUPPORTED_CONTENT"
        );
      }
    }
  }

  // ── Phase 3: exact offload using real base64 lengths ─────────────────────
  if (overflowPolicy === "offload-oldest") {
    projectedMessages = offloadRequestImagesWithPolicy(projectedMessages, {
      representation: "base64",
      maxImages: vision?.maxImages,
      maxBytes: maxInlineRequestImageBytes,
      byteQuantum: inlineImageOffloadByteQuantum,
      countQuantum: 1,
      byteLength: (ref) => {
        const version = requestImages.get(ref.attachmentId);
        return version != null ? BASE64_EXPANSION(version.bytes) : 0;
      }
    });

    // Verify protected images survived phase 3
    const keptIds3 = new Set(collectUniqueRefs(projectedMessages).map(r => r.attachmentId));
    for (const id of protectedIds) {
      if (!keptIds3.has(id)) {
        throw new LlmError(
          `GitHub Copilot model "${model.id}" cannot retain protected images within the configured inline request budget.`,
          "UNSUPPORTED_CONTENT"
        );
      }
    }
  }

  // ── Logging ────────────────────────────────────────────────────────────────
  const keptCount = collectImageOccurrences(projectedMessages).length;
  const omittedCount = allOccurrences.length - keptCount;
  if (omittedCount > 0 && logger != null) {
    const reason = vision?.maxImages !== undefined
      ? `maxImages=${vision.maxImages}`
      : `inline byte budget`;
    logger.warn(
      `GitHub Copilot model "${model.id}" omitted ${omittedCount} older request image${omittedCount === 1 ? "" : "s"} to satisfy ${reason}.`
    );
  }

  // ── Build resolve function ─────────────────────────────────────────────────
  const resolve = (ref) => {
    const version = requestImages.get(ref.attachmentId);
    if (version == null) return null; // was offloaded
    const dataUrl = `data:${version.mediaType};base64,${Buffer.from(version.data).toString("base64")}`;
    const handle = requestImageHandleText(version);
    return { version, dataUrl, handle, mediaType: version.mediaType };
  };

  return { messages: projectedMessages, resolve, omitted: omittedCount };
}
//#endregion
