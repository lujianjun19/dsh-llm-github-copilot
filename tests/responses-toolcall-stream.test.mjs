/**
 * Regression tests for Responses API tool-call argument streaming.
 *
 * GitHub Copilot's gpt-5.x (`/responses`) stream assigns a DIFFERENT opaque
 * `item_id` to every tool-call event: output_item.added,
 * function_call_arguments.delta, function_call_arguments.done, and
 * output_item.done all carry distinct ids. Matching the tool-call block by
 * `toolBlocks.get(item_id)` therefore never hit — every argument delta was
 * dropped and the block's arguments stayed empty, which made the client's
 * JSON.parse("") throw "Unexpected end of JSON input"
 * (api-proxy: presenter failed for tool/call). The translator must route and
 * close tool-call blocks by tracked reference instead.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { translateResponses } from '../lib/index.js'

async function* payloadsOf(events) {
  for (const e of events) yield JSON.stringify(e)
  yield '[DONE]'
}

async function collect(events) {
  const chunks = []
  for await (const chunk of translateResponses(payloadsOf(events))) chunks.push(chunk)
  return chunks
}

// One tool call. Every event carries a DISTINCT opaque item_id, exactly as
// observed in the live gpt-5.x stream. The final arguments arrive via
// function_call_arguments.done and output_item.done, not the deltas.
const ONE_TOOL_CALL = [
  { type: 'response.output_item.added', item: { type: 'function_call', id: 'ADD_aaa', name: 'bash', call_id: 'call_xyz' } },
  { type: 'response.function_call_arguments.delta', item_id: 'D_bbb', delta: '{"comm' },
  { type: 'response.function_call_arguments.delta', item_id: 'D_ccc', delta: 'and":"ls' },
  { type: 'response.function_call_arguments.delta', item_id: 'D_ddd', delta: ' /tmp"}' },
  { type: 'response.function_call_arguments.done', item_id: 'DONE_eee', arguments: '{"command":"ls /tmp"}' },
  { type: 'response.output_item.done', item: { type: 'function_call', id: 'ITEM_fff', name: 'bash', call_id: 'call_xyz', arguments: '{"command":"ls /tmp"}' } },
  { type: 'response.completed', response: { usage: {} } },
]

test('tool-call arguments assemble despite mismatched item_ids', async () => {
  const chunks = await collect(ONE_TOOL_CALL)
  const end = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.ok(end, 'a tool-call block-end is emitted')
  assert.equal(end.block.arguments, '{"command":"ls /tmp"}')
  assert.equal(end.block.name, 'bash')
  assert.equal(String(end.block.id), 'call_xyz')
})

test('assembled tool-call arguments are valid JSON (no empty-string parse)', async () => {
  const chunks = await collect(ONE_TOOL_CALL)
  const end = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
  // The bug produced arguments === "" → JSON.parse throws. Guard against it.
  assert.doesNotThrow(() => JSON.parse(end.block.arguments))
  assert.deepEqual(JSON.parse(end.block.arguments), { command: 'ls /tmp' })
})

test('tool-call delta chunks are forwarded to the correct block index', async () => {
  const chunks = await collect(ONE_TOOL_CALL)
  const start = chunks.find((c) => c.type === 'block-start' && c.blockType === 'tool-call')
  const deltas = chunks.filter((c) => c.type === 'tool-call-delta')
  assert.ok(deltas.length >= 1, 'at least one tool-call-delta forwarded')
  for (const d of deltas) assert.equal(d.index, start.index)
})

// Two sequential tool calls in one turn, all events with unique opaque ids.
const TWO_TOOL_CALLS = [
  { type: 'response.output_item.added', item: { type: 'function_call', id: 't1_add', name: 'bash', call_id: 'call_1' } },
  { type: 'response.function_call_arguments.delta', item_id: 't1_d', delta: '{"command":"pwd"}' },
  { type: 'response.function_call_arguments.done', item_id: 't1_done', arguments: '{"command":"pwd"}' },
  { type: 'response.output_item.done', item: { type: 'function_call', id: 't1_item', name: 'bash', call_id: 'call_1', arguments: '{"command":"pwd"}' } },
  { type: 'response.output_item.added', item: { type: 'function_call', id: 't2_add', name: 'bash', call_id: 'call_2' } },
  { type: 'response.function_call_arguments.delta', item_id: 't2_d', delta: '{"command":"whoami"}' },
  { type: 'response.function_call_arguments.done', item_id: 't2_done', arguments: '{"command":"whoami"}' },
  { type: 'response.output_item.done', item: { type: 'function_call', id: 't2_item', name: 'bash', call_id: 'call_2', arguments: '{"command":"whoami"}' } },
  { type: 'response.completed', response: { usage: {} } },
]

test('two sequential tool calls keep distinct arguments and call_ids', async () => {
  const chunks = await collect(TWO_TOOL_CALLS)
  const ends = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.equal(ends.length, 2)
  assert.equal(ends[0].block.arguments, '{"command":"pwd"}')
  assert.equal(String(ends[0].block.id), 'call_1')
  assert.equal(ends[1].block.arguments, '{"command":"whoami"}')
  assert.equal(String(ends[1].block.id), 'call_2')
  assert.notEqual(ends[0].index, ends[1].index)
})
