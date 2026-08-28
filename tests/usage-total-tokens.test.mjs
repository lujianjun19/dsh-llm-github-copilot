/**
 * Regression tests for provider-reported total tokens.
 *
 * The Turn usage panel is new in DeepSeek Harness `0.1.2-alpha.1`. Its token
 * meter discloses a completed Turn only when it can prove an exact total:
 * `TokenUsage.totalTokens` is that proof, and without it the meter falls back
 * to summing cache buckets and requires BOTH `cacheReadTokens` and
 * `cacheWriteTokens`. GitHub reports no cache-write bucket, so every Copilot
 * turn was discarded and the panel never rendered — while `usage.total_tokens`
 * sat unread on the wire in both formats.
 *
 * Seam: `translate` / `translateResponses`, so the assertions cover the usage
 * chunk the harness actually receives.
 *
 * The repository's devDependency pins token-meter `0.1.1-rc.2`, which predates
 * `deriveTurnTokenUsage`; the acceptance rule is therefore mirrored below from
 * the alpha source rather than imported.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { translate, translateResponses } from '../lib/index.js'

// ── stream helpers ───────────────────────────────────────────────────────────

async function* payloadsOf(events) {
  for (const e of events) yield JSON.stringify(e)
  yield '[DONE]'
}

async function chatUsage(usage) {
  const chunks = []
  for await (const chunk of translate(payloadsOf([
    { choices: [{ delta: { content: 'x' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage },
  ]))) chunks.push(chunk)
  return chunks.find(c => c.type === 'usage')?.usage
}

async function responsesUsage(usage) {
  const chunks = []
  for await (const chunk of translateResponses(payloadsOf([
    { type: 'response.output_text.delta', delta: 'x' },
    { type: 'response.completed', response: { usage } },
  ]))) chunks.push(chunk)
  return chunks.find(c => c.type === 'usage')?.usage
}

/**
 * The alpha token meter's acceptance rule, mirrored from
 * `packages/llm/token-meter/src/turn-usage.ts` (`normalizeUsage`). A sample it
 * rejects is dropped together with the whole turn's disclosure.
 */
function harnessAcceptsUsage(usage) {
  const isCount = (n) => Number.isSafeInteger(n) && n >= 0
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens } = usage
  if (!isCount(inputTokens) || !isCount(outputTokens)) return false
  const knownPrompt = inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
  if (totalTokens !== undefined) {
    if (!isCount(totalTokens)) return false
    const exactPrompt = totalTokens - outputTokens
    if (!isCount(exactPrompt) || exactPrompt < knownPrompt) return false
    return true
  }
  return cacheReadTokens !== undefined && cacheWriteTokens !== undefined
}

// ── the bug this fixes ───────────────────────────────────────────────────────

test('the pre-fix usage shape is rejected by the harness, hiding the panel', () => {
  // Exactly what this adapter emitted before: no totalTokens, and no
  // cacheWriteTokens because GitHub never reports one.
  assert.equal(harnessAcceptsUsage({ inputTokens: 900, outputTokens: 100, cacheReadTokens: 100 }), false)
  assert.equal(harnessAcceptsUsage({ inputTokens: 1000, outputTokens: 100 }), false)
})

// ── chat completions ─────────────────────────────────────────────────────────

test('chat: provider total_tokens rides through as totalTokens', async () => {
  const usage = await chatUsage({ prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 })
  assert.equal(usage.totalTokens, 1100)
  assert.equal(usage.inputTokens, 1000)
  assert.equal(usage.outputTokens, 100)
  assert.ok(harnessAcceptsUsage(usage), 'harness must accept the emitted sample')
})

test('chat: cached prompt tokens leave the provider total untouched', async () => {
  const usage = await chatUsage({
    prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100,
    prompt_tokens_details: { cached_tokens: 100 },
  })
  // inputTokens reports the UNCACHED remainder; the total stays the provider's own.
  assert.equal(usage.inputTokens, 900)
  assert.equal(usage.cacheReadTokens, 100)
  assert.equal(usage.totalTokens, 1100)
  assert.ok(harnessAcceptsUsage(usage))
})

test('chat: absent total_tokens omits the field rather than inventing one', async () => {
  const usage = await chatUsage({ prompt_tokens: 3, completion_tokens: 1 })
  assert.equal('totalTokens' in usage, false)
})

test('chat: a total below the reported buckets is dropped', async () => {
  // The harness derives prompt = total - output and rejects the sample when it
  // lands below the known prompt; passing such a value through would discard
  // the turn just as omitting it does.
  const usage = await chatUsage({ prompt_tokens: 1000, completion_tokens: 100, total_tokens: 500 })
  assert.equal('totalTokens' in usage, false)
})

test('chat: a non-integer total is dropped', async () => {
  const usage = await chatUsage({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12.5 })
  assert.equal('totalTokens' in usage, false)
})

// ── responses API ────────────────────────────────────────────────────────────

test('responses: provider total_tokens rides through as totalTokens', async () => {
  const usage = await responsesUsage({ input_tokens: 1000, output_tokens: 100, total_tokens: 1100 })
  assert.equal(usage.totalTokens, 1100)
  assert.equal(usage.inputTokens, 1000)
  assert.ok(harnessAcceptsUsage(usage), 'harness must accept the emitted sample')
})

test('responses: cached input and reasoning coexist with the provider total', async () => {
  const usage = await responsesUsage({
    input_tokens: 1000, output_tokens: 100, total_tokens: 1100,
    input_tokens_details: { cached_tokens: 100 },
    output_tokens_details: { reasoning_tokens: 40 },
  })
  assert.equal(usage.inputTokens, 900)
  assert.equal(usage.cacheReadTokens, 100)
  assert.equal(usage.reasoningTokens, 40)
  assert.equal(usage.totalTokens, 1100)
  assert.ok(harnessAcceptsUsage(usage))
})

test('responses: absent total_tokens omits the field', async () => {
  const usage = await responsesUsage({ input_tokens: 5, output_tokens: 2 })
  assert.equal('totalTokens' in usage, false)
})
