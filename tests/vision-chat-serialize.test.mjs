/**
 * Unit tests for Chat Completions serialization, including image support.
 * Tests the async serializeRequest() exported from lib/index.js.
 *
 * v0.4.0 changes:
 *   - Stable handle text (from requestImageHandleText) is emitted as a text
 *     part BEFORE each image_url part.
 *   - Tool-result images are supported: role:tool keeps text, images follow
 *     in a subsequent user message with per-call-id markers.
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
function toolResultMsg(callId, innerContent) {
  return {
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: callId, content: innerContent, isError: false }],
    source: { kind: 'tool', callId }
  }
}

function makeOptions(messages, model = 'gpt-4.1') {
  return { provider: 'github-copilot-official', model, messages }
}

/**
 * Mock imageResolver that returns a predetermined dataUrl and handle per
 * attachmentId.  The handle defaults to a string containing the id.
 */
function mockResolver(map = {}) {
  return {
    resolve(ref) {
      const entry = map[ref.attachmentId]
      if (!entry) return Promise.reject(new Error(`unexpected attachmentId: ${ref.attachmentId}`))
      return Promise.resolve({
        ref,
        bytes: entry.bytes ?? 512,
        mediaType: entry.mediaType ?? 'image/png',
        dataUrl: entry.dataUrl ?? `data:image/png;base64,${entry.b64 ?? 'AAAA'}`,
        handle: entry.handle ?? `Image ${ref.attachmentId}; request image 100x100px.`
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

// ── text + image (user messages) ──────────────────────────────────────────────

test('user message with text and image → [text, text(handle), image_url]', async () => {
  const opts = makeOptions([mixedMsg('describe this', 'img1')])
  const resolver = mockResolver({ img1: { dataUrl: 'data:image/png;base64,ABC' } })
  const body = await serializeRequest(opts, undefined, resolver)
  const msg = body.messages.find(m => m.role === 'user')
  assert.ok(Array.isArray(msg.content))
  assert.equal(msg.content[0].type, 'text')
  assert.equal(msg.content[0].text, 'describe this')
  assert.equal(msg.content[1].type, 'text')           // stable handle
  assert.ok(msg.content[1].text.includes('img1'))
  assert.equal(msg.content[2].type, 'image_url')
  assert.equal(msg.content[2].image_url.url, 'data:image/png;base64,ABC')
})

test('image-only user message → [text(handle), image_url]', async () => {
  const opts = makeOptions([imageMsg('img2')])
  const resolver = mockResolver({ img2: { dataUrl: 'data:image/jpeg;base64,XYZ' } })
  const body = await serializeRequest(opts, undefined, resolver)
  const msg = body.messages.find(m => m.role === 'user')
  assert.ok(Array.isArray(msg.content))
  assert.equal(msg.content.length, 2)
  assert.equal(msg.content[0].type, 'text')            // handle
  assert.equal(msg.content[1].type, 'image_url')
  assert.equal(msg.content[1].image_url.url, 'data:image/jpeg;base64,XYZ')
})

test('image + text + image order is preserved with handles interspersed', async () => {
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
  // Expected: [handle1, image_url1, text, handle2, image_url2]
  assert.equal(parts[0].type, 'text')          // handle for img1
  assert.ok(parts[0].text.includes('img1'))
  assert.equal(parts[1].type, 'image_url')
  assert.equal(parts[1].image_url.url, 'data:image/png;base64,A1')
  assert.equal(parts[2].type, 'text')
  assert.equal(parts[2].text, 'between')
  assert.equal(parts[3].type, 'text')          // handle for img2
  assert.ok(parts[3].text.includes('img2'))
  assert.equal(parts[4].type, 'image_url')
  assert.equal(parts[4].image_url.url, 'data:image/png;base64,A2')
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

// ── tool-result images ────────────────────────────────────────────────────────

test('tool-result with image → role:tool text + following role:user with image', async () => {
  const opts = makeOptions([
    toolResultMsg('call-1', [textBlock('screenshot taken'), imageBlock('tool-img')])
  ])
  const resolver = mockResolver({ 'tool-img': { dataUrl: 'data:image/png;base64,TOOL' } })
  const body = await serializeRequest(opts, undefined, resolver)
  // tool message: text content only
  const toolMsg = body.messages.find(m => m.role === 'tool')
  assert.ok(toolMsg, 'should have a role:tool message')
  assert.equal(toolMsg.tool_call_id, 'call-1')
  assert.equal(toolMsg.content, 'screenshot taken')
  // user message: image with call-id marker
  const userMsg = body.messages.find(m => m.role === 'user')
  assert.ok(userMsg, 'should have a following role:user message')
  assert.ok(Array.isArray(userMsg.content))
  const marker = userMsg.content.find(p => p.type === 'text' && p.text.includes('call-1'))
  assert.ok(marker, 'user message should have call-id marker text')
  const imgPart = userMsg.content.find(p => p.type === 'image_url')
  assert.ok(imgPart, 'user message should have image_url part')
  assert.equal(imgPart.image_url.url, 'data:image/png;base64,TOOL')
})

test('tool-result text-only → role:tool message, no following user message', async () => {
  const opts = makeOptions([
    toolResultMsg('call-2', [textBlock('done')])
  ])
  const body = await serializeRequest(opts, undefined, noopResolver)
  const toolMsgs = body.messages.filter(m => m.role === 'tool')
  assert.equal(toolMsgs.length, 1)
  assert.equal(toolMsgs[0].content, 'done')
  // no spurious user message with images
  const userWithArray = body.messages.filter(m => m.role === 'user' && Array.isArray(m.content))
  assert.equal(userWithArray.length, 0, 'no extra user message when no tool images')
})

test('parallel tool calls, both with images → two tool messages + one user image message', async () => {
  const opts = makeOptions([
    toolResultMsg('c1', [textBlock('result 1'), imageBlock('img-c1')]),
    toolResultMsg('c2', [textBlock('result 2'), imageBlock('img-c2')])
  ])
  const resolver = mockResolver({
    'img-c1': { dataUrl: 'data:image/png;base64,C1' },
    'img-c2': { dataUrl: 'data:image/png;base64,C2' }
  })
  const body = await serializeRequest(opts, undefined, resolver)
  const toolMsgs = body.messages.filter(m => m.role === 'tool')
  assert.equal(toolMsgs.length, 2, 'should have two tool messages')
  assert.equal(toolMsgs[0].tool_call_id, 'c1')
  assert.equal(toolMsgs[1].tool_call_id, 'c2')
  // both tool images come in ONE following user message
  const userImgMsgs = body.messages.filter(m => m.role === 'user' && Array.isArray(m.content))
  assert.equal(userImgMsgs.length, 1, 'should have exactly one user image message')
  const content = userImgMsgs[0].content
  const markerC1 = content.find(p => p.type === 'text' && p.text.includes('c1'))
  const markerC2 = content.find(p => p.type === 'text' && p.text.includes('c2'))
  assert.ok(markerC1, 'should have c1 marker')
  assert.ok(markerC2, 'should have c2 marker')
  const imgUrls = content.filter(p => p.type === 'image_url')
  assert.equal(imgUrls.length, 2, 'both images should be in the user message')
})

test('tool messages followed by assistant then tool-result image → images follow second tool batch', async () => {
  const opts = makeOptions([
    toolResultMsg('c1', [textBlock('t1')]),
    { role: 'assistant', content: [textBlock('thinking')], source: { kind: 'model', provider: 'p', model: 'm' } },
    toolResultMsg('c2', [textBlock('t2'), imageBlock('img-late')])
  ])
  const resolver = mockResolver({ 'img-late': { dataUrl: 'data:image/png;base64,LATE' } })
  const body = await serializeRequest(opts, undefined, resolver)
  const toolMsgs = body.messages.filter(m => m.role === 'tool')
  assert.equal(toolMsgs.length, 2)
  const userImgMsgs = body.messages.filter(m => m.role === 'user' && Array.isArray(m.content))
  assert.equal(userImgMsgs.length, 1)
  const imgPart = userImgMsgs[0].content.find(p => p.type === 'image_url')
  assert.equal(imgPart.image_url.url, 'data:image/png;base64,LATE')
  // verify ordering: tool(c2) comes before the user-image message
  const c2Idx = body.messages.findIndex(m => m.role === 'tool' && m.tool_call_id === 'c2')
  const userImgIdx = body.messages.indexOf(userImgMsgs[0])
  assert.ok(c2Idx < userImgIdx, 'tool message must come before the image user message')
})

test('mixed tool-result: one with image, one without → only one user image message', async () => {
  const opts = makeOptions([
    toolResultMsg('c1', [textBlock('no image here')]),
    toolResultMsg('c2', [textBlock('has image'), imageBlock('img-c2')])
  ])
  const resolver = mockResolver({ 'img-c2': { dataUrl: 'data:image/png;base64,C2' } })
  const body = await serializeRequest(opts, undefined, resolver)
  const userImgMsgs = body.messages.filter(m => m.role === 'user' && Array.isArray(m.content))
  assert.equal(userImgMsgs.length, 1)
  const marker = userImgMsgs[0].content.find(p => p.type === 'text' && p.text.includes('c2'))
  assert.ok(marker)
  // should NOT have c1 marker (no image for c1)
  const markerC1 = userImgMsgs[0].content.find(p => p.type === 'text' && p.text.includes('c1'))
  assert.equal(markerC1, undefined)
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
