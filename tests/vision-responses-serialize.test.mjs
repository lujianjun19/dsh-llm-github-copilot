/**
 * Unit tests for Responses API serialization, including input_image support.
 * Tests the async serializeResponsesRequest() exported from lib/index.js.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { serializeResponsesRequest } from '../lib/index.js'

// ── helpers ──────────────────────────────────────────────────────────────────

function textBlock(text) { return { type: 'text', text } }
function imageBlock(id) {
  return { type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', bytes: 512, width: 100, height: 100 } }
}

function mockResolver(map = {}) {
  return {
    resolve(ref) {
      const entry = map[ref.attachmentId]
      if (!entry) return Promise.reject(new Error(`unexpected attachmentId: ${ref.attachmentId}`))
      return Promise.resolve({
        ref, bytes: 512, mediaType: 'image/png',
        dataUrl: entry.dataUrl ?? `data:image/png;base64,${entry.b64 ?? 'AAAA'}`
      })
    }
  }
}

const noopResolver = { resolve: () => Promise.reject(new Error('unexpected image')) }

function makeOpts(messages, model = 'gpt-5.6-luna') {
  return { provider: 'github-copilot-official', model, messages }
}

// ── pure text ─────────────────────────────────────────────────────────────────

test('pure text user message → input_text item', async () => {
  const opts = makeOpts([{
    role: 'user', content: [textBlock('hello')], source: { kind: 'user' }
  }])
  const body = await serializeResponsesRequest(opts, undefined, noopResolver)
  const item = body.input.find(i => i.role === 'user')
  assert.ok(Array.isArray(item.content))
  assert.equal(item.content[0].type, 'input_text')
  assert.equal(item.content[0].text, 'hello')
})

test('system message → input_text in system role', async () => {
  const opts = { ...makeOpts([]), system: 'be helpful' }
  const body = await serializeResponsesRequest(opts, undefined, noopResolver)
  const sys = body.input[0]
  assert.equal(sys.role, 'system')
  assert.equal(sys.content[0].type, 'input_text')
  assert.equal(sys.content[0].text, 'be helpful')
})

// ── image support ─────────────────────────────────────────────────────────────

test('user message with image → input_image item', async () => {
  const opts = makeOpts([{
    role: 'user', content: [imageBlock('img1')], source: { kind: 'user' }
  }])
  const resolver = mockResolver({ img1: { dataUrl: 'data:image/png;base64,IMGDATA' } })
  const body = await serializeResponsesRequest(opts, undefined, resolver)
  const item = body.input.find(i => i.role === 'user')
  const imgPart = item.content.find(p => p.type === 'input_image')
  assert.ok(imgPart, 'should have input_image part')
  assert.equal(imgPart.image_url, 'data:image/png;base64,IMGDATA')
})

test('text + image → ordered input_text then input_image', async () => {
  const opts = makeOpts([{
    role: 'user',
    content: [textBlock('look at this'), imageBlock('img2')],
    source: { kind: 'user' }
  }])
  const resolver = mockResolver({ img2: { dataUrl: 'data:image/png;base64,DATA2' } })
  const body = await serializeResponsesRequest(opts, undefined, resolver)
  const parts = body.input.find(i => i.role === 'user').content
  assert.equal(parts[0].type, 'input_text')
  assert.equal(parts[0].text, 'look at this')
  assert.equal(parts[1].type, 'input_image')
})

// ── rejection rules ───────────────────────────────────────────────────────────

test('system message with image → UNSUPPORTED_CONTENT', async () => {
  const opts = makeOpts([{
    role: 'system',
    content: [imageBlock('img-sys')],
    source: { kind: 'plugin', plugin: 'test' }
  }])
  const { LlmError } = await import('@deepseek-ai/dsh-llm')
  await assert.rejects(
    serializeResponsesRequest(opts, undefined, noopResolver),
    (err) => err instanceof LlmError && err.code === 'UNSUPPORTED_CONTENT'
  )
})

test('assistant message with image → UNSUPPORTED_CONTENT', async () => {
  const opts = makeOpts([{
    role: 'assistant',
    content: [textBlock('ok'), imageBlock('img-asst')],
    source: { kind: 'model', provider: 'p', model: 'm' }
  }])
  const { LlmError } = await import('@deepseek-ai/dsh-llm')
  await assert.rejects(
    serializeResponsesRequest(opts, undefined, noopResolver),
    (err) => err instanceof LlmError && err.code === 'UNSUPPORTED_CONTENT'
  )
})

test('tool-result with image → UNSUPPORTED_CONTENT', async () => {
  const opts = makeOpts([{
    role: 'user',
    content: [{
      type: 'tool-result', toolCallId: 'c1',
      content: [imageBlock('img-tool')], isError: false
    }],
    source: { kind: 'tool', callId: 'c1' }
  }])
  const { LlmError } = await import('@deepseek-ai/dsh-llm')
  await assert.rejects(
    serializeResponsesRequest(opts, undefined, noopResolver),
    (err) => err instanceof LlmError && err.code === 'UNSUPPORTED_CONTENT'
  )
})

// ── tool call serialization (fix: function_call top-level item) ───────────────

// The Responses API only accepts `output_text` and `refusal` inside an
// assistant message's content array.  Tool calls must be top-level
// `function_call` items, not nested in the message content.
// Regression: https://github.com/lujianjun19/dsh-llm-github-copilot (v0.3.6
// produced `output_tool_call` inside content, triggering the server error
// "Invalid value: 'output_tool_call'. Supported values are: 'output_text'...")

test('tool call only in assistant turn → top-level function_call item, no assistant message', async () => {
  const opts = makeOpts([{
    role: 'assistant',
    content: [{ type: 'tool-call', id: 'call-abc', name: 'search', arguments: '{"q":"test"}' }],
    source: { kind: 'model', provider: 'p', model: 'm' }
  }])
  const body = await serializeResponsesRequest(opts, undefined, noopResolver)

  // Must produce exactly one top-level function_call item
  const fcItems = body.input.filter(i => i.type === 'function_call')
  assert.equal(fcItems.length, 1, 'exactly one function_call top-level item')
  assert.equal(fcItems[0].name, 'search')
  assert.equal(fcItems[0].call_id, 'call-abc')
  assert.equal(fcItems[0].arguments, '{"q":"test"}')

  // `id` (fc_...) is API-generated and NOT required when replaying; the adapter
  // omits it and relies on call_id for correlation.
  assert.equal(fcItems[0].id, undefined, 'id must be omitted (not required for replay)')
  assert.equal(fcItems[0].call_id, 'call-abc', 'call_id must be the original call_... value')

  // Must NOT produce an assistant message with no content
  const asstMsg = body.input.find(i => i.role === 'assistant')
  assert.equal(asstMsg, undefined, 'no assistant message when there is only a tool call')
})

test('real-world call_… id → id omitted, call_id preserved (regression)', async () => {
  // Reproduces the exact server error reported with gpt-5.6-terra:
  //   "Invalid 'input[4].id': 'call_00_JrdrVQskenAyDcreGWUA4666'.
  //    Expected an ID that begins with 'fc'."
  // The fix is to OMIT the id entirely — it is not a required field on
  // FunctionToolCall and the adapter no longer has the original fc_ item id.
  const callId = 'call_00_JrdrVQskenAyDcreGWUA4666'
  const opts = makeOpts([{
    role: 'assistant',
    content: [{ type: 'tool-call', id: callId, name: 'get_weather', arguments: '{"city":"Tokyo"}' }],
    source: { kind: 'model', provider: 'p', model: 'm' }
  }])
  const body = await serializeResponsesRequest(opts, undefined, noopResolver)

  const fc = body.input.find(i => i.type === 'function_call')
  assert.ok(fc, 'function_call item present')
  assert.equal(fc.id, undefined, 'id must be omitted')
  assert.equal(fc.call_id, callId, 'call_id must preserve the original call_… value')
  assert.equal(fc.name, 'get_weather')
  assert.equal(fc.arguments, '{"city":"Tokyo"}')
})

test('multiple tool calls → no id field, distinct call_id per call', async () => {
  const opts = makeOpts([{
    role: 'assistant',
    content: [
      { type: 'tool-call', id: 'call-1', name: 'a', arguments: '{}' },
      { type: 'tool-call', id: 'call-2', name: 'b', arguments: '{}' },
    ],
    source: { kind: 'model', provider: 'p', model: 'm' }
  }])
  const body = await serializeResponsesRequest(opts, undefined, noopResolver)
  const fcs = body.input.filter(i => i.type === 'function_call')
  assert.equal(fcs.length, 2)
  assert.equal(fcs[0].id, undefined, 'id must be omitted on every function_call')
  assert.equal(fcs[1].id, undefined, 'id must be omitted on every function_call')
  assert.equal(fcs[0].call_id, 'call-1')
  assert.equal(fcs[1].call_id, 'call-2')
})

test('tool call never appears inside assistant message content', async () => {
  const opts = makeOpts([{
    role: 'assistant',
    content: [{ type: 'tool-call', id: 'call-abc', name: 'search', arguments: '{}' }],
    source: { kind: 'model', provider: 'p', model: 'm' }
  }])
  const body = await serializeResponsesRequest(opts, undefined, noopResolver)
  for (const item of body.input) {
    if (!Array.isArray(item.content)) continue
    for (const part of item.content) {
      assert.notEqual(part.type, 'output_tool_call',
        'output_tool_call must never appear in content — it is not a valid Responses API content type')
    }
  }
})

test('assistant text + tool call → separate message and function_call items', async () => {
  const opts = makeOpts([{
    role: 'assistant',
    content: [
      textBlock('I will search for that.'),
      { type: 'tool-call', id: 'call-xyz', name: 'search', arguments: '{"q":"foo"}' }
    ],
    source: { kind: 'model', provider: 'p', model: 'm' }
  }])
  const body = await serializeResponsesRequest(opts, undefined, noopResolver)

  // Text goes into an assistant message with output_text content
  const asstMsg = body.input.find(i => i.role === 'assistant')
  assert.ok(asstMsg, 'assistant message item present')
  assert.equal(asstMsg.type, 'message')
  assert.equal(asstMsg.content.length, 1)
  assert.equal(asstMsg.content[0].type, 'output_text')
  assert.equal(asstMsg.content[0].text, 'I will search for that.')

  // Tool call goes into a top-level function_call item
  const fc = body.input.find(i => i.type === 'function_call')
  assert.ok(fc, 'function_call top-level item present')
  assert.equal(fc.name, 'search')
  assert.equal(fc.call_id, 'call-xyz')
})

test('multi-turn with tool use → correct Responses API structure', async () => {
  // Simulates a two-turn tool-use conversation:
  //   user → assistant (tool call) → user (tool result + next question)
  // This is the exact sequence that triggered the original bug on gpt-5.6-terra.
  const opts = makeOpts([
    { role: 'user',      content: [textBlock('What is the weather in Tokyo?')], source: { kind: 'user' } },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'get_weather', arguments: '{"city":"Tokyo"}' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    { role: 'user',      content: [{ type: 'tool-result', toolCallId: 'call-1', content: [textBlock('Sunny, 28°C')], isError: false }], source: { kind: 'tool', callId: 'call-1' } },
    { role: 'user',      content: [textBlock('Thanks, and what about Osaka?')], source: { kind: 'user' } },
  ])
  const body = await serializeResponsesRequest(opts, undefined, noopResolver)

  const types = body.input.map(i => i.type ?? i.role)
  // Expected order: user(message), function_call, function_call_output, user(message)
  assert.deepEqual(types, ['user', 'function_call', 'function_call_output', 'user'],
    `unexpected input item order: ${JSON.stringify(types)}`)

  const fc = body.input.find(i => i.type === 'function_call')
  assert.equal(fc.name, 'get_weather')
  assert.equal(fc.call_id, 'call-1')

  const fco = body.input.find(i => i.type === 'function_call_output')
  assert.equal(fco.call_id, 'call-1')
  assert.equal(fco.output, 'Sunny, 28°C')
})

test('multiple tool calls in one assistant turn → multiple function_call items in order', async () => {
  const opts = makeOpts([{
    role: 'assistant',
    content: [
      { type: 'tool-call', id: 'call-1', name: 'tool_a', arguments: '{"x":1}' },
      { type: 'tool-call', id: 'call-2', name: 'tool_b', arguments: '{"y":2}' },
    ],
    source: { kind: 'model', provider: 'p', model: 'm' }
  }])
  const body = await serializeResponsesRequest(opts, undefined, noopResolver)

  const fcs = body.input.filter(i => i.type === 'function_call')
  assert.equal(fcs.length, 2)
  assert.equal(fcs[0].name, 'tool_a')
  assert.equal(fcs[0].call_id, 'call-1')
  assert.equal(fcs[1].name, 'tool_b')
  assert.equal(fcs[1].call_id, 'call-2')
})

// ── existing behavior preserved ───────────────────────────────────────────────

test('stream is always true in Responses wire', async () => {
  const body = await serializeResponsesRequest(makeOpts([{ role: 'user', content: [textBlock('hi')], source: { kind: 'user' } }]), undefined, noopResolver)
  assert.equal(body.stream, true)
})
