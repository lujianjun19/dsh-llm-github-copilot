/**
 * Regression tests for the chat-completions translator. Before BlockStream this
 * path had no test at all; these lock in reasoning, text, tool-call streaming,
 * the usage-before-finish ordering, and the empty-response and error rules
 * across the `translate()` interface.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { translate } from '../lib/index.js'

/** Feed chat-completions chunks as an async SSE-payload iterable, then [DONE]. */
async function* payloadsOf(chunks) {
  for (const c of chunks) yield JSON.stringify(c)
  yield '[DONE]'
}

async function collect(chunks) {
  const out = []
  for await (const chunk of translate(payloadsOf(chunks))) out.push(chunk)
  return out
}

test('reasoning + text stream as two ordered blocks', async () => {
  const chunks = await collect([
    { choices: [{ delta: { reasoning_content: 'think' } }] },
    { choices: [{ delta: { content: 'answer' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ])
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'think' },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'answer' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' } },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('tool call accumulates arguments across deltas keyed by call.index', async () => {
  const chunks = await collect([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'grep', arguments: '{"q":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ])
  const end = chunks.find(c => c.type === 'block-end')
  assert.deepEqual(end.block, { type: 'tool-call', id: 'call_1', name: 'grep', arguments: '{"q":"hi"}' })
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
})

test('two concurrent tool calls stay distinct by index', async () => {
  const chunks = await collect([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'f', arguments: '{}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'g', arguments: '{}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ])
  const ends = chunks.filter(c => c.type === 'block-end')
  assert.deepEqual(ends.map(e => e.block.id), ['a', 'b'])
  assert.deepEqual(ends.map(e => e.block.name), ['f', 'g'])
})

test('usage is emitted before finish', async () => {
  const chunks = await collect([
    { choices: [{ delta: { content: 'x' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
  ])
  const usageAt = chunks.findIndex(c => c.type === 'usage')
  const finishAt = chunks.findIndex(c => c.type === 'finish')
  assert.ok(usageAt !== -1 && usageAt < finishAt)
})

test('completed stream with no content yields the empty-response error', async () => {
  const chunks = await collect([{ choices: [{ delta: {}, finish_reason: 'stop' }] }])
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.code, 'EMPTY_RESPONSE')
})

test('an error-kind finish reason survives as a failure, not empty-response', async () => {
  const chunks = await collect([{ choices: [{ delta: {}, finish_reason: 'content_filter' }] }])
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'CONTENT_FILTER')
})
