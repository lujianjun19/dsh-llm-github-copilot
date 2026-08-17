/**
 * Unit tests for Chat Completions serialization, including image support.
 * Tests the async serializeRequest() exported from lib/index.js.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { serializeRequest } from '../lib/index.js'

// ── helpers ──────────────────────────────────────────────────────────────────

function textBlock(text) { return { type: 'text', text } }
function imageBlock(id, mediaType = 'image/png', bytes = 1024) {
  return { type: 'image', attachment: { attachmentId: id, mediaType, bytes, width: 100, height: 100 } }
}
function textMsg(text, role = 'user') {
  return { role, content: [textBlock(text)], source: { kind: role === 'user' ? 'user' : 'model' } }
}
function imageMsg(id) {
  return { role: 'user', content: [imageBlock(id)], source: { kind: 'user' } }
}
function mixedMsg(text, id) {
  return { role: 'user', content: [textBlock(text), imageBlock(id)], source: { kind: 'user' } }
}

function makeOptions(messages, model = 'gpt-4.1') {
  return { provider: 'github-copilot-official', model, messages }
}

/** Mock imageResolver that returns a predetermined dataUrl per attachmentId. */
function mockResolver(map = {}) {
  return {
    resolve(ref) {
      const entry = map[ref.attachmentId]
      if (!entry) return Promise.reject(new Error(`unexpected attachmentId: ${ref.attachmentId}`))
      return Promise.resolve({
        ref,
        bytes: entry.bytes ?? 512,
        mediaType: entry.mediaType ?? 'image/png',
        dataUrl: entry.dataUrl ?? `data:image/png;base64,${entry.b64 ?? 'AAAA'}`
      })
    }
  }
}

const noopResolver = { resolve: () => Promise.reject(new Error('unexpected image')) }

// ── pure text (backward-compat wire shape) ────────────────────────────────────

test('pure text user message → string content (not array)', async () => {
  const opts = makeOptions([textMsg('hello', 'user')])
  const body = await serializeRequest(opts, undefined, noopResolver)
  const msg = body.messages.find(m => m.role === 'user')
  assert.equal(typeof msg.content, 'string')
  assert.equal(msg.content, 'hello')
})

test('pure text system message → string content', async () => {
  const opts = { ...makeOptions([]), system: 'be helpful' }
  const body = await serializeRequest(opts, undefined, noopResolver)
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[0].content, 'be helpful')
})

test('multiple pure-text turns produce only string-content messages', async () => {
  const opts = makeOptions([
    textMsg('hi', 'user'),
    { role: 'assistant', content: [textBlock('hello')], source: { kind: 'model', provider: 'p', model: 'm' } },
    textMsg('thanks', 'user')
  ])
  const body = await serializeRequest(opts, undefined, noopResolver)
  for (const m of body.messages) {
    assert.equal(typeof m.content, 'string', `message role=${m.role} should have string content`)
  }
})

// ── text + image ──────────────────────────────────────────────────────────────

test('user message with text and image → content array with text+image_url', async () => {
  const opts = makeOptions([mixedMsg('describe this', 'img1')])
  const resolver = mockResolver({ img1: { dataUrl: 'data:image/png;base64,ABC' } })
  const body = await serializeRequest(opts, undefined, resolver)
  const msg = body.messages.find(m => m.role === 'user')
  assert.ok(Array.isArray(msg.content))
  assert.equal(msg.content[0].type, 'text')
  assert.equal(msg.content[0].text, 'describe this')
  assert.equal(msg.content[1].type, 'image_url')
  assert.equal(msg.content[1].image_url.url, 'data:image/png;base64,ABC')
})

test('image-only user message → content array with single image_url', async () => {
  const opts = makeOptions([imageMsg('img2')])
  const resolver = mockResolver({ img2: { dataUrl: 'data:image/jpeg;base64,XYZ' } })
  const body = await serializeRequest(opts, undefined, resolver)
  const msg = body.messages.find(m => m.role === 'user')
  assert.ok(Array.isArray(msg.content))
  assert.equal(msg.content.length, 1)
  assert.equal(msg.content[0].type, 'image_url')
  assert.equal(msg.content[0].image_url.url, 'data:image/jpeg;base64,XYZ')
})

test('image + text + image order is preserved in content array', async () => {
  const opts = makeOptions([{
    role: 'user',
    content: [imageBlock('img1'), textBlock('between'), imageBlock('img2')],
    source: { kind: 'user' }
  }])
  const resolver = mockResolver({
    img1: { dataUrl: 'data:image/png;base64,A1' },
    img2: { dataUrl: 'data:image/png;base64,A2' }
  })
  const body = await serializeRequest(opts, undefined, resolver)
  const parts = body.messages.find(m => m.role === 'user').content
  assert.equal(parts[0].type, 'image_url')
  assert.equal(parts[0].image_url.url, 'data:image/png;base64,A1')
  assert.equal(parts[1].type, 'text')
  assert.equal(parts[1].text, 'between')
  assert.equal(parts[2].type, 'image_url')
  assert.equal(parts[2].image_url.url, 'data:image/png;base64,A2')
})

// ── image rejection rules ─────────────────────────────────────────────────────

test('system message with image → UNSUPPORTED_CONTENT', async () => {
  const opts = makeOptions([{
    role: 'system',
    content: [textBlock('prompt'), imageBlock('img-sys')],
    source: { kind: 'plugin', plugin: 'test' }
  }])
  const { LlmError } = await import('@deepseek-ai/dsh-llm')
  await assert.rejects(
    serializeRequest(opts, undefined, noopResolver),
    (err) => err instanceof LlmError && err.code === 'UNSUPPORTED_CONTENT'
  )
})

test('assistant message with image → UNSUPPORTED_CONTENT', async () => {
  const opts = makeOptions([{
    role: 'assistant',
    content: [textBlock('response'), imageBlock('img-asst')],
    source: { kind: 'model', provider: 'p', model: 'm' }
  }])
  const { LlmError } = await import('@deepseek-ai/dsh-llm')
  await assert.rejects(
    serializeRequest(opts, undefined, noopResolver),
    (err) => err instanceof LlmError && err.code === 'UNSUPPORTED_CONTENT'
  )
})

test('tool-result content with image → UNSUPPORTED_CONTENT', async () => {
  const opts = makeOptions([{
    role: 'user',
    content: [{
      type: 'tool-result',
      toolCallId: 'call-1',
      content: [imageBlock('img-tool')],
      isError: false
    }],
    source: { kind: 'tool', callId: 'call-1' }
  }])
  const { LlmError } = await import('@deepseek-ai/dsh-llm')
  await assert.rejects(
    serializeRequest(opts, undefined, noopResolver),
    (err) => err instanceof LlmError && err.code === 'UNSUPPORTED_CONTENT'
  )
})

// ── wire shape invariants ─────────────────────────────────────────────────────

test('stream and stream_options fields are always present', async () => {
  const body = await serializeRequest(makeOptions([textMsg('hi')]), undefined, noopResolver)
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
})

test('model id is forwarded to wire', async () => {
  const body = await serializeRequest(makeOptions([textMsg('hi')], 'gpt-4o'), undefined, noopResolver)
  assert.equal(body.model, 'gpt-4o')
})
