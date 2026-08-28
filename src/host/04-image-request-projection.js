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
 * Strict `error` mode skips offloading and instead rejects any request that
 * exceeds the model image count or the inline byte budget (exact bytes).
 *
 * The returned resolve(ref) function looks up by attachmentId. Offloaded images
 * return null; their placeholder text is already in the projected messages.
 *
 * @module dsh-llm-github-copilot/image-request-projection
 */

const BASE64_EXPANSION = (bytes) => Math.ceil(bytes / 3) * 4;

/**
 * Walk every image block in message order, including nested tool-result content,
 * invoking `visit(attachmentRef, sourceKind)` per occurrence. The single shared
 * traversal used by occurrence counting, unique-ref collection, and protection.
 */
function walkImages(messages, visit) {
  for (const msg of messages) {
    const kind = msg.source?.kind;
    for (const block of msg.content) {
      if (block.type === "image") {
        visit(block.attachment, kind);
      } else if (block.type === "tool-result") {
        for (const inner of block.content) {
          if (inner.type === "image") visit(inner.attachment, kind);
        }
      }
    }
  }
}

/** Collect all image AttachmentRefs by occurrence order (same id may appear multiple times). */
function collectImageOccurrences(messages) {
  const refs = [];
  walkImages(messages, (ref) => refs.push(ref));
  return refs;
}

/** Collect unique AttachmentRefs (by attachmentId) for I/O. */
function collectUniqueRefs(messages) {
  const seen = new Map();
  walkImages(messages, (ref) => {
    if (!seen.has(ref.attachmentId)) seen.set(ref.attachmentId, ref);
  });
  return [...seen.values()];
}

/** Set of attachmentIds present in a message list. */
function attachmentIdSet(messages) {
  const ids = new Set();
  walkImages(messages, (ref) => ids.add(ref.attachmentId));
  return ids;
}

/**
 * Identify protected attachmentIds that must not be dropped by offload-oldest,
 * separated by provenance so error messages can name the conflict precisely.
 *
 * Protected set:
 *   1. Images from the last message with source.kind === "user"
 *      (the most recent human-authored turn).
 *   2. Images from the last consecutive run of source.kind === "tool" messages
 *      at the tail of the history (the latest tool-result batch).
 *
 * @returns {{ userIds: Set<string>, toolIds: Set<string>, all: Set<string> }}
 */
function identifyProtectedIds(messages) {
  const userIds = new Set();
  const toolIds = new Set();

  // Last human-authored message.
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].source?.kind === "user") {
      walkImages([messages[i]], (ref) => userIds.add(ref.attachmentId));
      break;
    }
  }

  // Last consecutive run of tool-result messages at the tail.
  let lastToolIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].source?.kind === "tool") lastToolIdx = i;
    else break;
  }
  if (lastToolIdx >= 0) {
    walkImages(messages.slice(lastToolIdx), (ref) => toolIds.add(ref.attachmentId));
  }

  return { userIds, toolIds, all: new Set([...userIds, ...toolIds]) };
}

/**
 * Apply the overflow policy and return projected messages + a resolve function.
 *
 * @param {object} params
 * @param {readonly import('@deepseek-ai/dsh-llm').Message[]} params.messages
 * @param {object} params.model  - catalog entry (may have .vision limits)
 * @param {object | null | undefined} params.attachmentStore
 * @param {AbortSignal | undefined} params.signal
 * @param {((ref: object) => object | undefined) | undefined} [params.resolveImageAccess]
 *   - resolves one durable image to a read-only execution-world path, so the
 *     model can re-read the full-fidelity file instead of only seeing the
 *     downscaled request preview. Undefined leaves every handle pathless.
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
  resolveImageAccess,
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

  /**
   * Run one offload pass and assert every protected image survived.
   * @param {readonly Message[]} input - messages to project.
   * @param {(ref: object) => number} byteLength - base64 length estimator.
   * @returns {readonly Message[]} the projected messages.
   */
  const offloadAndVerify = (input, byteLength) => {
    const projected = offloadRequestImagesWithPolicy(input, {
      representation: "base64",
      maxImages: vision?.maxImages,
      maxBytes: maxInlineRequestImageBytes,
      byteQuantum: inlineImageOffloadByteQuantum,
      countQuantum: 1,
      byteLength,
      ...LLM.offloadPlaceholderFor(resolveImageAccess)
    });
    const kept = attachmentIdSet(projected);
    for (const id of protectedIds.all) {
      if (!kept.has(id)) throw protectedRetentionError();
    }
    return projected;
  };

  /**
   * Build the error thrown when protected images cannot all be retained. When a
   * current user image and a latest tool-result image are both protected, name
   * both; otherwise report the inline budget generically.
   */
  const protectedRetentionError = () => {
    if (protectedIds.userIds.size > 0 && protectedIds.toolIds.size > 0
      && vision?.maxImages !== undefined) {
      return new LlmError(
        `GitHub Copilot model "${model.id}" cannot retain both the current user image and the latest tool-result image within its ${vision.maxImages}-image request limit.`,
        "UNSUPPORTED_CONTENT"
      );
    }
    return new LlmError(
      `GitHub Copilot model "${model.id}" cannot retain protected images within the configured inline request budget.`,
      "UNSUPPORTED_CONTENT"
    );
  };

  // ── Guard: the current user submission alone must fit the image count ───────
  // Count images only in the last human-authored message itself.
  const lastUserMsg = [...messages].reverse().find(m => m.source?.kind === "user");
  const currentUserImageCount = lastUserMsg ? collectImageOccurrences([lastUserMsg]).length : 0;
  if (vision?.maxImages !== undefined && currentUserImageCount > vision.maxImages) {
    throw new LlmError(
      `GitHub Copilot model "${model.id}" accepts at most ${vision.maxImages} image${vision.maxImages === 1 ? "" : "s"} per request; the current user message contains ${currentUserImageCount} protected images.`,
      "UNSUPPORTED_CONTENT"
    );
  }

  // ── Strict mode: reject on image-count overflow before any I/O ──────────────
  if (overflowPolicy === "error" && vision?.maxImages !== undefined
    && allOccurrences.length > vision.maxImages) {
    throw new LlmError(
      `GitHub Copilot model "${model.id}" image request exceeds maxImages=${vision.maxImages} while imageOverflowPolicy is "error".`,
      "UNSUPPORTED_CONTENT"
    );
  }

  // ── Phase 1: conservative offload (no I/O) ──────────────────────────────────
  let projectedMessages = messages;
  if (overflowPolicy === "offload-oldest") {
    projectedMessages = offloadAndVerify(
      messages,
      (ref) => BASE64_EXPANSION(Math.min(ref.bytes, requestPolicy.maxBytes))
    );
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

  // Validate derived MIMEs against the model allowlist.
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

  // Validate derived bytes against the model's published per-image limit.
  // `ImageRequestPolicy.maxBytes` is a target, not a cap: when no quality on
  // the encoder ladder meets it the store returns its smallest output anyway,
  // which can still exceed the Provider limit. Failing here names the limit
  // instead of surfacing an opaque Provider rejection.
  if (vision?.maxImageBytes !== undefined) {
    for (const [, version] of requestImages) {
      if (version.bytes > vision.maxImageBytes) {
        throw new LlmError(
          `GitHub Copilot model "${model.id}" accepts images up to ${vision.maxImageBytes} bytes; the derived request image is ${version.bytes} bytes.`,
          "UNSUPPORTED_CONTENT"
        );
      }
    }
  }

  const exactBase64Length = (ref) => {
    const version = requestImages.get(ref.attachmentId);
    return version != null ? BASE64_EXPANSION(version.bytes) : 0;
  };

  if (overflowPolicy === "error") {
    // Enforce the inline byte budget on exact derived bytes.
    const totalBase64 = collectUniqueRefs(projectedMessages).reduce(
      (sum, ref) => sum + exactBase64Length(ref), 0
    );
    if (totalBase64 > maxInlineRequestImageBytes) {
      throw new LlmError(
        `GitHub Copilot image input for model "${model.id}" exceeds the configured ${maxInlineRequestImageBytes}-byte inline request budget while imageOverflowPolicy is "error".`,
        "UNSUPPORTED_CONTENT"
      );
    }
  } else {
    // ── Phase 3: exact offload using real base64 lengths ────────────────────
    projectedMessages = offloadAndVerify(projectedMessages, exactBase64Length);
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
    const handle = LLM.requestImageHandle(ref, version, resolveImageAccess?.(ref));
    return { version, dataUrl, handle, mediaType: version.mediaType };
  };

  return { messages: projectedMessages, resolve, omitted: omittedCount };
}
//#endregion
