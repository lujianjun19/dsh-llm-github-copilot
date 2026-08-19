/**
 * Direct unit tests for the BlockStream reducer — the shared, wire-agnostic
 * block assembler both translators drive. Because every method returns the
 * StreamChunks to emit (rather than yielding), the module is testable through
 * its interface without reconstructing an SSE byte stream.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { BlockStream } from '../lib/index.js'

test('text() opens the block once, then only emits deltas', () => {
  const bs = new BlockStream()
  assert.deepEqual(bs.text('he'), [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'he' },
  ])
  assert.deepEqual(bs.text('llo'), [{ type: 'text-delta', index: 0, text: 'llo' }])
})

test('finish() flushes an open block, then emits usage then finish', () => {
  const bs = new BlockStream()
  bs.text('hi')
  const usage = { inputTokens: 1, outputTokens: 2 }
  assert.deepEqual(bs.finish({ usage, reason: { kind: 'stop' } }), [
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('finish() with zero blocks and no failure yields the empty-response error', () => {
  const bs = new BlockStream()
  const [finish] = bs.finish({ reason: { kind: 'stop' } })
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE')
})

test('finish() with an explicit failure wins over the empty-response rule', () => {
  const bs = new BlockStream()
  const failure = { kind: 'error', failure: { message: 'boom', code: 'MODEL_FAILED' } }
  assert.deepEqual(bs.finish({ failure }), [{ type: 'finish', reason: failure }])
})

test('reasoningIsEmpty tracks whether a reasoning block has content', () => {
  const bs = new BlockStream()
  assert.equal(bs.reasoningIsEmpty, true)
  bs.openReasoning()
  assert.equal(bs.reasoningIsEmpty, true, 'opened but empty')
  bs.reasoning('thinking')
  assert.equal(bs.reasoningIsEmpty, false)
})

test('tool-call handle: openToolCall → toolArgs → updateTool → closeToolCall', () => {
  const bs = new BlockStream()
  const { handle, chunks } = bs.openToolCall({ name: 'grep', callId: 'call_1' })
  assert.deepEqual(chunks, [{ type: 'block-start', index: 0, blockType: 'tool-call' }])
  assert.deepEqual(bs.toolArgs(handle, '{"a'), [
    { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'grep', argumentsDelta: '{"a' },
  ])
  // Authoritative override does not emit; empty arguments never clobber.
  bs.updateTool(handle, { arguments: '' })
  bs.updateTool(handle, { arguments: '{"a":1}' })
  assert.deepEqual(bs.closeToolCall(handle), [
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'grep', arguments: '{"a":1}' } },
  ])
})

test('closeToolCall is idempotent — finish() does not double-emit block-end', () => {
  const bs = new BlockStream()
  const { handle } = bs.openToolCall({ callId: 'call_9' })
  bs.toolArgs(handle, '{}')
  const closed = bs.closeToolCall(handle)
  assert.equal(closed.length, 1)
  const trailing = bs.finish({ reason: { kind: 'tool-calls' } })
  // Only usage(none) + finish remain; the already-closed block is not re-ended.
  assert.deepEqual(trailing, [{ type: 'finish', reason: { kind: 'tool-calls' } }])
})

test('block indices increase in open order across kinds', () => {
  const bs = new BlockStream()
  bs.reasoning('r')
  bs.text('t')
  const { handle } = bs.openToolCall({ callId: 'c' })
  bs.toolArgs(handle, '{}')
  const ends = bs.finish({ reason: { kind: 'stop' } }).filter(c => c.type === 'block-end')
  assert.deepEqual(ends.map(e => e.index), [0, 1, 2])
  assert.deepEqual(ends.map(e => e.block.type), ['reasoning', 'text', 'tool-call'])
})
