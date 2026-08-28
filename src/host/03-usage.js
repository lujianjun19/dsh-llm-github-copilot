//#region provider usage mapping
/**
 * Shared provider-usage helpers for both wire formats.
 *
 * The harness only discloses a completed Turn's token accounting when it can
 * prove an exact total. `TokenUsage.totalTokens` is the direct proof; without
 * it the token meter falls back to summing the cache buckets and requires
 * BOTH `cacheReadTokens` and `cacheWriteTokens` to be present, otherwise it
 * drops the whole turn. GitHub never reports a cache-write bucket, so omitting
 * the provider total silently suppressed the Turn usage panel on every
 * request.
 *
 * Both GitHub wire formats already carry the total (`usage.total_tokens`), so
 * this is a pass-through of data that was on the wire all along.
 */

/**
 * Build the optional `totalTokens` field from a provider-reported total.
 *
 * Emitted only when the value is a usable count that is consistent with the
 * buckets already reported: the harness derives `prompt = total - output` and
 * rejects the sample outright when that lands below the known prompt total.
 * Passing an inconsistent value through would therefore discard the usage just
 * as omitting it does, so an unusable total is dropped here where the reason
 * can be stated.
 *
 * @param {unknown} total - provider-reported total across prompt and output.
 * @param {number} knownPromptTokens - prompt tokens this adapter reports (uncached + cached).
 * @param {number} outputTokens - output tokens this adapter reports.
 * @returns {{ totalTokens?: number }} a spreadable field, empty when unusable.
 */
function totalTokensField(total, knownPromptTokens, outputTokens) {
  if (!Number.isSafeInteger(total) || total < 0) return {};
  const promptFromTotal = total - outputTokens;
  if (!Number.isSafeInteger(promptFromTotal) || promptFromTotal < knownPromptTokens) return {};
  return { totalTokens: total };
}
//#endregion

