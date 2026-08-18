/**
 * Regression tests for Responses API reasoning-summary streaming.
 *
 * GitHub Copilot's gpt-5.x (`/responses`) stream assigns a DIFFERENT opaque
 * `item_id` to every reasoning event (output_item.added,
 * reasoning_summary_part.added, reasoning_summary_text.delta, and
 * output_item.done all carry distinct ids). The translator must therefore route
 * and close reasoning blocks by tracked reference, never by id lookup — else the
 * Think block never emits block-end (stuck streaming) and later segments break.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { translateResponses } from '../lib/index.js'

/** Feed an array of event objects as an async SSE-payload iterable. */
async function* payloadsOf(events) {
  for (const e of events) yield JSON.stringify(e)
  yield '[DONE]'
}

/** Drain translateResponses into an array of chunks. */
async function collect(events) {
  const chunks = []
  for await (const chunk of translateResponses(payloadsOf(events))) chunks.push(chunk)
  return chunks
}

// A single reasoning segment: every event carries a DISTINCT opaque item_id.
const ONE_SEGMENT = [
  { type: 'response.created' },
  { type: 'response.output_item.added', item: { type: 'reasoning', id: 'ADD_id_aaa' } },
  { type: 'response.reasoning_summary_part.added', item_id: 'PART_id_bbb' },
  { type: 'response.reasoning_summary_text.delta', item_id: 'DELTA_id_ccc', delta: 'Let me' },
  { type: 'response.reasoning_summary_text.delta', item_id: 'DELTA_id_ddd', delta: ' think' },
  { type: 'response.reasoning_summary_text.done', item_id: 'DONE_id_eee' },
  { type: 'response.reasoning_summary_part.done', item_id: 'PART_id_fff' },
  { type: 'response.output_item.done', item: { type: 'reasoning', id: 'DONEITEM_id_ggg' } },
  { type: 'response.output_item.added', item: { type: 'message', id: 'msg1' } },
  { type: 'response.content_part.added', part: { type: 'output_text' } },
  { type: 'response.output_text.delta', content_index: 0, delta: '17 is prime' },
  { type: 'response.output_item.done', item: { type: 'message', id: 'msg1' } },
  { type: 'response.completed', response: { usage: {} } },
]

test('reasoning delta routes despite mismatched item_ids', async () => {
  const chunks = await collect(ONE_SEGMENT)
  const deltas = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text)
  assert.deepEqual(deltas, ['Let me', ' think'])
})

test('reasoning block emits block-end even though done item.id differs', async () => {
  const chunks = await collect(ONE_SEGMENT)
  const ends = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'reasoning')
  assert.equal(ends.length, 1, 'exactly one reasoning block-end')
  assert.equal(ends[0].block.text, 'Let me think')
})

test('reasoning block-start precedes its deltas and block-end', async () => {
  const chunks = await collect(ONE_SEGMENT)
  const start = chunks.findIndex((c) => c.type === 'block-start' && c.blockType === 'reasoning')
  const end = chunks.findIndex((c) => c.type === 'block-end' && c.block.type === 'reasoning')
  const firstDelta = chunks.findIndex((c) => c.type === 'reasoning-delta')
  assert.ok(start >= 0 && firstDelta > start && end > firstDelta, 'start < delta < end ordering')
})

// Two reasoning segments in one turn (as happens before each tool call). Every
// event across BOTH segments has a unique opaque id.
const TWO_SEGMENTS = [
  { type: 'response.output_item.added', item: { type: 'reasoning', id: 'seg1_add' } },
  { type: 'response.reasoning_summary_part.added', item_id: 'seg1_part' },
  { type: 'response.reasoning_summary_text.delta', item_id: 'seg1_d1', delta: 'First' },
  { type: 'response.output_item.done', item: { type: 'reasoning', id: 'seg1_done' } },
  { type: 'response.output_item.added', item: { type: 'reasoning', id: 'seg2_add' } },
  { type: 'response.reasoning_summary_part.added', item_id: 'seg2_part' },
  { type: 'response.reasoning_summary_text.delta', item_id: 'seg2_d1', delta: 'Second' },
  { type: 'response.output_item.done', item: { type: 'reasoning', id: 'seg2_done' } },
  { type: 'response.completed', response: { usage: {} } },
]

test('two reasoning segments produce two separate blocks', async () => {
  const chunks = await collect(TWO_SEGMENTS)
  const starts = chunks.filter((c) => c.type === 'block-start' && c.blockType === 'reasoning')
  const ends = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'reasoning')
  assert.equal(starts.length, 2, 'two reasoning block-starts')
  assert.equal(ends.length, 2, 'two reasoning block-ends')
  assert.equal(ends[0].block.text, 'First')
  assert.equal(ends[1].block.text, 'Second')
  // The two segments must land on distinct block indices.
  assert.notEqual(ends[0].index, ends[1].index)
})

test("second segment's delta does not leak into the first block", async () => {
  const chunks = await collect(TWO_SEGMENTS)
  const ends = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'reasoning')
  assert.equal(ends[0].block.text, 'First', 'first block holds only its own text')
})

// Multiple summary parts within ONE reasoning item get a blank-line separator.
const MULTI_PART = [
  { type: 'response.output_item.added', item: { type: 'reasoning', id: 'r_add' } },
  { type: 'response.reasoning_summary_part.added', item_id: 'p1' },
  { type: 'response.reasoning_summary_text.delta', item_id: 'd1', delta: 'Part one' },
  { type: 'response.reasoning_summary_part.added', item_id: 'p2' },
  { type: 'response.reasoning_summary_text.delta', item_id: 'd2', delta: 'Part two' },
  { type: 'response.output_item.done', item: { type: 'reasoning', id: 'r_done' } },
  { type: 'response.completed', response: { usage: {} } },
]

test('multiple summary parts are separated by a blank line', async () => {
  const chunks = await collect(MULTI_PART)
  const ends = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'reasoning')
  assert.equal(ends.length, 1)
  assert.equal(ends[0].block.text, 'Part one\n\nPart two')
})
