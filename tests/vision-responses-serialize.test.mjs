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

// ── existing behavior preserved ───────────────────────────────────────────────

test('tool call in assistant turn → output_tool_call item preserved', async () => {
  const opts = makeOpts([{
    role: 'assistant',
    content: [{
      type: 'tool-call', id: 'call-abc', name: 'search', arguments: '{"q":"test"}'
    }],
    source: { kind: 'model', provider: 'p', model: 'm' }
  }])
  const body = await serializeResponsesRequest(opts, undefined, noopResolver)
  const asst = body.input.find(i => i.role === 'assistant')
  const tc = asst.content.find(c => c.type === 'output_tool_call')
  assert.ok(tc)
  assert.equal(tc.name, 'search')
  assert.equal(tc.arguments, '{"q":"test"}')
})

test('stream is always true in Responses wire', async () => {
  const body = await serializeResponsesRequest(makeOpts([{ role: 'user', content: [textBlock('hi')], source: { kind: 'user' } }]), undefined, noopResolver)
  assert.equal(body.stream, true)
})
