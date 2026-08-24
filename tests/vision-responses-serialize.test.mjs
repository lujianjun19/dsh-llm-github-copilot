/**
 * Unit tests for Responses API serialization, including input_image support.
 * Tests the async serializeResponsesRequest() exported from lib/index.js.
 *
 * v0.4.0 changes:
 *   - Stable handle text (input_text) emitted BEFORE each input_image part.
 *   - Tool-result images are supported: function_call_output keeps text, images
 *     follow in a subsequent role:user message with per-call-id markers.
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
        dataUrl: entry.dataUrl ?? `data:image/png;base64,${entry.b64 ?? 'AAAA'}`,
        handle: entry.handle ?? `Image ${ref.attachmentId}; request image 100x100px.`
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

test('text + image → [input_text, input_text(handle), input_image]', async () => {
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
  assert.equal(parts[1].type, 'input_text')   // stable handle
  assert.ok(parts[1].text.includes('img2'))
  assert.equal(parts[2].type, 'input_image')
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

// ── tool-result images ────────────────────────────────────────────────────────

test('tool-result with image → function_call_output text + following user input_image', async () => {
  const opts = makeOpts([{
    role: 'user',
    content: [{
      type: 'tool-result', toolCallId: 'c1',
      content: [textBlock('screenshot'), imageBlock('img-tool')], isError: false
    }],
    source: { kind: 'tool', callId: 'c1' }
  }])
  const resolver = mockResolver({ 'img-tool': { dataUrl: 'data:image/png;base64,TOOL' } })
  const body = await serializeResponsesRequest(opts, undefined, resolver)
  // function_call_output: text only
  const fco = body.input.find(i => i.type === 'function_call_output')
  assert.ok(fco, 'should have function_call_output')
  assert.equal(fco.call_id, 'c1')
  assert.equal(fco.output, 'screenshot')
  // following user input with call-id marker and image
  const userItems = body.input.filter(i => i.role === 'user')
  const imgItem = userItems.find(i => Array.isArray(i.content) && i.content.some(p => p.type === 'input_image'))
  assert.ok(imgItem, 'should have following user item with input_image')
  const marker = imgItem.content.find(p => p.type === 'input_text' && p.text.includes('c1'))
  assert.ok(marker, 'user item should have call-id marker text')
  const imgPart = imgItem.content.find(p => p.type === 'input_image')
  assert.equal(imgPart.image_url, 'data:image/png;base64,TOOL')
})

test('two tool-results with images → two function_call_outputs + one user image item', async () => {
  const opts = makeOpts([
    {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [textBlock('r1'), imageBlock('img1')], isError: false }],
      source: { kind: 'tool', callId: 'c1' }
    },
    {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c2', content: [textBlock('r2'), imageBlock('img2')], isError: false }],
      source: { kind: 'tool', callId: 'c2' }
    }
  ])
  const resolver = mockResolver({
    img1: { dataUrl: 'data:image/png;base64,I1' },
    img2: { dataUrl: 'data:image/png;base64,I2' }
  })
  const body = await serializeResponsesRequest(opts, undefined, resolver)
  const fcos = body.input.filter(i => i.type === 'function_call_output')
  assert.equal(fcos.length, 2, 'two function_call_output items')
  // ONE following user item with both images
  const userImgItems = body.input.filter(i => i.role === 'user' && Array.isArray(i.content)
    && i.content.some(p => p.type === 'input_image'))
  assert.equal(userImgItems.length, 1, 'exactly one user image item for both tools')
  const imgs = userImgItems[0].content.filter(p => p.type === 'input_image')
  assert.equal(imgs.length, 2, 'both images in the user item')
  const markerC1 = userImgItems[0].content.find(p => p.type === 'input_text' && p.text.includes('c1'))
  const markerC2 = userImgItems[0].content.find(p => p.type === 'input_text' && p.text.includes('c2'))
  assert.ok(markerC1)
  assert.ok(markerC2)
})

// ── tool call serialization ───────────────────────────────────────────────────

test('tool call only in assistant turn → top-level function_call item, no assistant message', async () => {
  const opts = makeOpts([{
    role: 'assistant',
    content: [{ type: 'tool-call', id: 'call-abc', name: 'search', arguments: '{"q":"test"}' }],
    source: { kind: 'model', provider: 'p', model: 'm' }
  }])
  const body = await serializeResponsesRequest(opts, undefined, noopResolver)
  const fcItems = body.input.filter(i => i.type === 'function_call')
  assert.equal(fcItems.length, 1, 'exactly one function_call top-level item')
  assert.equal(fcItems[0].name, 'search')
  assert.equal(fcItems[0].call_id, 'call-abc')
  assert.equal(fcItems[0].arguments, '{"q":"test"}')
  assert.equal(fcItems[0].id, undefined, 'id must be omitted')
  const asstMsg = body.input.find(i => i.role === 'assistant')
  assert.equal(asstMsg, undefined, 'no assistant message when there is only a tool call')
})

test('real-world call_… id → id omitted, call_id preserved (regression)', async () => {
  const callId = 'call_00_JrdrVQskenAyDcreGWUA4666'
  const opts = makeOpts([{
    role: 'assistant',
    content: [{ type: 'tool-call', id: callId, name: 'get_weather', arguments: '{"city":"Tokyo"}' }],
    source: { kind: 'model', provider: 'p', model: 'm' }
  }])
  const body = await serializeResponsesRequest(opts, undefined, noopResolver)
  const fc = body.input.find(i => i.type === 'function_call')
  assert.ok(fc)
  assert.equal(fc.id, undefined)
  assert.equal(fc.call_id, callId)
  assert.equal(fc.name, 'get_weather')
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
  assert.equal(fcs[0].id, undefined)
  assert.equal(fcs[1].id, undefined)
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
      assert.notEqual(part.type, 'output_tool_call')
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
  const asstMsg = body.input.find(i => i.role === 'assistant')
  assert.ok(asstMsg)
  assert.equal(asstMsg.type, 'message')
  assert.equal(asstMsg.content[0].type, 'output_text')
  assert.equal(asstMsg.content[0].text, 'I will search for that.')
  const fc = body.input.find(i => i.type === 'function_call')
  assert.ok(fc)
  assert.equal(fc.name, 'search')
  assert.equal(fc.call_id, 'call-xyz')
})

test('multi-turn with tool use → correct Responses API structure', async () => {
  const opts = makeOpts([
    { role: 'user',      content: [textBlock('What is the weather in Tokyo?')], source: { kind: 'user' } },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'get_weather', arguments: '{"city":"Tokyo"}' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    { role: 'user',      content: [{ type: 'tool-result', toolCallId: 'call-1', content: [textBlock('Sunny, 28°C')], isError: false }], source: { kind: 'tool', callId: 'call-1' } },
    { role: 'user',      content: [textBlock('Thanks, and what about Osaka?')], source: { kind: 'user' } },
  ])
  const body = await serializeResponsesRequest(opts, undefined, noopResolver)
  const types = body.input.map(i => i.type ?? i.role)
  assert.deepEqual(types, ['user', 'function_call', 'function_call_output', 'user'],
    `unexpected input item order: ${JSON.stringify(types)}`)
  const fc = body.input.find(i => i.type === 'function_call')
  assert.equal(fc.name, 'get_weather')
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
