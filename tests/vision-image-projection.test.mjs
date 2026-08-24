/**
 * Unit tests for prepareRequestImages — the per-request image projection module.
 *
 * Seam: the public prepareRequestImages function exported from lib/index.js.
 * It encapsulates all image overflow logic, readImageRequest calls, MIME
 * validation, stable handles, and offload-oldest vs error policies.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareRequestImages } from '../lib/index.js'

// ── helpers ──────────────────────────────────────────────────────────────────

function pngData(bytes = 512) {
  return new Uint8Array(bytes).fill(1)
}

/**
 * Build a minimal ImageAttachmentRef-like object.
 */
function makeRef(id, bytes = 512, mediaType = 'image/png') {
  return { attachmentId: id, mediaType, bytes, width: 100, height: 100 }
}

/**
 * Build an image content block.
 */
function imageBlock(id, bytes = 512, mediaType = 'image/png') {
  return { type: 'image', attachment: makeRef(id, bytes, mediaType) }
}

/**
 * Build a text content block.
 */
function textBlock(text) {
  return { type: 'text', text }
}

/**
 * Build a user message with given content blocks and source kind.
 */
function userMsg(content, sourceKind = 'user') {
  return { role: 'user', content, source: { kind: sourceKind } }
}

/**
 * Build a tool-result message for a given call-id with content blocks.
 */
function toolMsg(callId, innerContent) {
  return {
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: callId, content: innerContent, isError: false }],
    source: { kind: 'tool', callId }
  }
}

/**
 * Create a mock AttachmentStore whose readImageRequest returns deterministic
 * RequestImageAttachment-like objects.
 *
 * @param {Record<string, {data?: Uint8Array, mediaType?: string}>} images
 */
function makeStore(images = {}) {
  const calls = []
  const store = {
    calls,
    async readImageRequest(ref, policy, signal) {
      calls.push({ id: ref.attachmentId, policy, signal })
      const img = images[ref.attachmentId]
      if (!img) throw new Error(`unknown image: ${ref.attachmentId}`)
      await new Promise(r => setImmediate(r))
      if (signal?.aborted) throw signal.reason
      const data = img.data ?? pngData(64)
      const mediaType = img.mediaType ?? ref.mediaType
      return {
        variantId: `v-${ref.attachmentId}`,
        attachment: ref,
        data,
        mediaType,
        bytes: data.byteLength,
        width: img.width ?? ref.width,
        height: img.height ?? ref.height,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false
      }
    }
  }
  return store
}

/**
 * Default options for prepareRequestImages that don't trigger overflow.
 */
function defaultOpts(overrides = {}) {
  return {
    model: { id: 'test-model', vision: undefined },
    overflowPolicy: 'offload-oldest',
    defaultImagePixelBudget: 4194304,
    maxInlineRequestImageBytes: 20 * 1024 * 1024,
    inlineImageOffloadByteQuantum: 10 * 1024 * 1024,
    ...overrides
  }
}

// ── basic resolution: readImageRequest called, resolve returns handle+dataUrl ─

test('resolve returns a dataUrl and handle for a kept image', async () => {
  const msgs = [userMsg([textBlock('hello'), imageBlock('img1')])]
  const store = makeStore({ img1: {} })
  const { resolve } = await prepareRequestImages({
    messages: msgs,
    attachmentStore: store,
    signal: undefined,
    ...defaultOpts()
  })
  const r = resolve(makeRef('img1'))
  assert.ok(r, 'should resolve img1')
  assert.match(r.dataUrl, /^data:image\/png;base64,/)
  // handle must contain attachmentId and dimensions
  assert.ok(r.handle.includes('img1'), 'handle should reference attachmentId')
  assert.ok(r.handle.includes('px'), 'handle should mention dimensions')
})

test('resolve uses storage-layer verified mediaType not ref claim', async () => {
  const msgs = [userMsg([imageBlock('img2', 512, 'image/jpeg')])]
  // store returns png even though ref says jpeg
  const store = makeStore({ img2: { mediaType: 'image/png' } })
  const { resolve } = await prepareRequestImages({
    messages: msgs,
    attachmentStore: store,
    signal: undefined,
    ...defaultOpts()
  })
  const r = resolve(makeRef('img2', 512, 'image/jpeg'))
  assert.equal(r.mediaType, 'image/png', 'should use storage-layer mediaType')
  assert.match(r.dataUrl, /^data:image\/png;base64,/)
})

// ── I/O deduplication ─────────────────────────────────────────────────────────

test('same attachmentId in two messages → readImageRequest called once', async () => {
  const msgs = [
    userMsg([imageBlock('img3')], 'model'),   // history, treated as non-protected
    userMsg([imageBlock('img3')])              // last user msg, protected
  ]
  const store = makeStore({ img3: {} })
  await prepareRequestImages({
    messages: msgs,
    attachmentStore: store,
    signal: undefined,
    ...defaultOpts()
  })
  assert.equal(store.calls.filter(c => c.id === 'img3').length, 1,
    'readImageRequest should be called only once per unique attachmentId')
})

test('different attachmentIds → separate readImageRequest calls', async () => {
  const msgs = [
    userMsg([imageBlock('img4')], 'model'),
    userMsg([imageBlock('img5')])
  ]
  const store = makeStore({ img4: {}, img5: {} })
  await prepareRequestImages({
    messages: msgs,
    attachmentStore: store,
    signal: undefined,
    ...defaultOpts()
  })
  assert.equal(store.calls.length, 2, 'one call per unique attachmentId')
})

// ── AbortSignal ───────────────────────────────────────────────────────────────

test('AbortSignal is forwarded to readImageRequest', async () => {
  const msgs = [userMsg([imageBlock('img6')])]
  const store = makeStore({ img6: {} })
  const ac = new AbortController()
  const { resolve } = await prepareRequestImages({
    messages: msgs,
    attachmentStore: store,
    signal: ac.signal,
    ...defaultOpts()
  })
  assert.equal(store.calls[0].signal, ac.signal, 'signal should be forwarded')
})

// ── missing attachmentStore ───────────────────────────────────────────────────

test('null attachmentStore → UNSUPPORTED_CONTENT', async () => {
  const msgs = [userMsg([imageBlock('x')])]
  await assert.rejects(
    () => prepareRequestImages({ messages: msgs, attachmentStore: null, signal: undefined, ...defaultOpts() }),
    (err) => err.code === 'UNSUPPORTED_CONTENT'
  )
})

test('undefined attachmentStore → UNSUPPORTED_CONTENT', async () => {
  const msgs = [userMsg([imageBlock('x')])]
  await assert.rejects(
    () => prepareRequestImages({ messages: msgs, attachmentStore: undefined, signal: undefined, ...defaultOpts() }),
    (err) => err.code === 'UNSUPPORTED_CONTENT'
  )
})

// ── MIME validation on derived type ──────────────────────────────────────────

test('derived MIME in allowlist → passes', async () => {
  const msgs = [userMsg([imageBlock('img-ok', 64, 'image/png')])]
  const store = makeStore({ 'img-ok': { mediaType: 'image/png' } })
  const model = { id: 'strict', vision: { mediaTypes: ['image/png', 'image/jpeg'] } }
  const { resolve } = await prepareRequestImages({
    messages: msgs, attachmentStore: store, signal: undefined,
    ...defaultOpts({ model })
  })
  assert.ok(resolve(makeRef('img-ok')), 'should resolve ok')
})

test('derived MIME NOT in allowlist → UNSUPPORTED_CONTENT', async () => {
  const msgs = [userMsg([imageBlock('img-bad', 64, 'image/png')])]
  // store returns webp but model only accepts jpeg/png
  const store = makeStore({ 'img-bad': { mediaType: 'image/webp' } })
  const model = { id: 'strict', vision: { mediaTypes: ['image/jpeg', 'image/png'] } }
  await assert.rejects(
    () => prepareRequestImages({ messages: msgs, attachmentStore: store, signal: undefined, ...defaultOpts({ model }) }),
    (err) => {
      assert.equal(err.code, 'UNSUPPORTED_CONTENT')
      assert.ok(err.message.includes('image/webp'), 'error should mention the bad MIME')
      return true
    }
  )
})

// ── offload-oldest: maxImages ─────────────────────────────────────────────────

test('same attachmentId counted as 2 occurrences for maxImages', async () => {
  // img-dup appears in history (not protected) and in last user msg (protected)
  // maxImages=1 → the history occurrence is offloaded, last msg is kept
  const msgs = [
    userMsg([imageBlock('img-dup')], 'model'),  // older, offloadable
    userMsg([imageBlock('img-dup')])             // last user msg, protected
  ]
  const store = makeStore({ 'img-dup': {} })
  const model = { id: 'm', vision: { maxImages: 1 } }
  const result = await prepareRequestImages({
    messages: msgs, attachmentStore: store, signal: undefined,
    ...defaultOpts({ model })
  })
  // readImageRequest called once (unique ids)
  assert.equal(store.calls.length, 1)
  // first message should have placeholder (image was offloaded)
  const firstMsgBlocks = result.messages[0].content
  assert.equal(firstMsgBlocks.some(b => b.type === 'text' && b.text.includes('omitted')), true,
    'offloaded image should be replaced with placeholder')
  // last message should still have the image block
  const lastMsgBlocks = result.messages[1].content
  assert.equal(lastMsgBlocks.some(b => b.type === 'image'), true,
    'protected image in last user msg should survive')
})

test('two distinct images, maxImages=1 → older offloaded, newer kept', async () => {
  const msgs = [
    userMsg([imageBlock('img-old')], 'model'),  // history, offloadable
    userMsg([imageBlock('img-new')])             // current, protected
  ]
  const store = makeStore({ 'img-old': {}, 'img-new': {} })
  const model = { id: 'm', vision: { maxImages: 1 } }
  const result = await prepareRequestImages({
    messages: msgs, attachmentStore: store, signal: undefined,
    ...defaultOpts({ model })
  })
  // readImageRequest only for img-new (img-old offloaded in phase 1)
  assert.ok(!store.calls.some(c => c.id === 'img-old'), 'offloaded image should not be read')
  assert.ok(store.calls.some(c => c.id === 'img-new'), 'kept image should be read')
  // img-new resolve works
  const r = result.resolve(makeRef('img-new'))
  assert.ok(r, 'img-new should resolve')
  // img-old is null (was offloaded)
  const r2 = result.resolve(makeRef('img-old'))
  assert.equal(r2, null, 'offloaded image should resolve to null')
})

// ── error mode ────────────────────────────────────────────────────────────────

test('error mode: maxImages exceeded → UNSUPPORTED_CONTENT', async () => {
  const msgs = [
    userMsg([imageBlock('e1')], 'model'),
    userMsg([imageBlock('e2')])
  ]
  const store = makeStore({ e1: {}, e2: {} })
  const model = { id: 'm', vision: { maxImages: 1 } }
  await assert.rejects(
    () => prepareRequestImages({
      messages: msgs, attachmentStore: store, signal: undefined,
      ...defaultOpts({ model, overflowPolicy: 'error' })
    }),
    (err) => {
      assert.equal(err.code, 'UNSUPPORTED_CONTENT')
      return true
    }
  )
})

// ── error mode: inline byte budget ───────────────────────────────────────────

test('error mode: total derived base64 exceeds maxInlineRequestImageBytes → UNSUPPORTED_CONTENT', async () => {
  // Two images, each derives to 64 bytes → ~88 base64 bytes each → ~176 total.
  // maxInlineRequestImageBytes = 100 forces the byte budget to be exceeded.
  const msgs = [
    userMsg([imageBlock('b1')], 'model'),
    userMsg([imageBlock('b2')])
  ]
  const store = makeStore({ b1: {}, b2: {} })
  await assert.rejects(
    () => prepareRequestImages({
      messages: msgs, attachmentStore: store, signal: undefined,
      ...defaultOpts({ overflowPolicy: 'error', maxInlineRequestImageBytes: 100 })
    }),
    (err) => {
      assert.equal(err.code, 'UNSUPPORTED_CONTENT')
      assert.ok(/inline request budget/.test(err.message), 'error should mention the inline byte budget')
      return true
    }
  )
})

test('error mode: derived bytes within budget → succeeds', async () => {
  const msgs = [userMsg([imageBlock('ok1')])]
  const store = makeStore({ ok1: {} })
  const result = await prepareRequestImages({
    messages: msgs, attachmentStore: store, signal: undefined,
    ...defaultOpts({ overflowPolicy: 'error', maxInlineRequestImageBytes: 20 * 1024 * 1024 })
  })
  assert.ok(result.resolve(makeRef('ok1')), 'image within budget should resolve')
})

// ── protected images ──────────────────────────────────────────────────────────

test('current user image + latest tool image conflict → message names both', async () => {
  // maxImages=1, but the latest human message has one image AND the latest
  // tool batch has one image → both protected, cannot both be retained.
  const msgs = [
    userMsg([imageBlock('u1')]),
    toolMsg('c1', [textBlock('shot'), imageBlock('t1')])
  ]
  const store = makeStore({ u1: {}, t1: {} })
  const model = { id: 'gpt-4.1', vision: { maxImages: 1 } }
  await assert.rejects(
    () => prepareRequestImages({
      messages: msgs, attachmentStore: store, signal: undefined,
      ...defaultOpts({ model })
    }),
    (err) => {
      assert.equal(err.code, 'UNSUPPORTED_CONTENT')
      assert.ok(/current user image/.test(err.message), 'message should mention the current user image')
      assert.ok(/tool-result image/.test(err.message), 'message should mention the tool-result image')
      return true
    }
  )
})

test('current user image alone exceeds maxImages → UNSUPPORTED_CONTENT', async () => {
  // User sends 2 images in one message, but model only accepts 1
  const msgs = [
    userMsg([imageBlock('p1'), imageBlock('p2')])  // last user, both protected
  ]
  const store = makeStore({ p1: {}, p2: {} })
  const model = { id: 'm', vision: { maxImages: 1 } }
  await assert.rejects(
    () => prepareRequestImages({
      messages: msgs, attachmentStore: store, signal: undefined,
      ...defaultOpts({ model })
    }),
    (err) => {
      assert.equal(err.code, 'UNSUPPORTED_CONTENT')
      return true
    }
  )
})

test('no overflow when no vision limits → all images kept', async () => {
  const msgs = [
    userMsg([imageBlock('a1')], 'model'),
    userMsg([imageBlock('a2')], 'model'),
    userMsg([imageBlock('a3')])
  ]
  const store = makeStore({ a1: {}, a2: {}, a3: {} })
  const model = { id: 'm', vision: undefined }
  const result = await prepareRequestImages({
    messages: msgs, attachmentStore: store, signal: undefined,
    ...defaultOpts({ model })
  })
  assert.equal(store.calls.length, 3, 'all three images should be read')
  assert.equal(result.omitted, 0, 'nothing should be omitted')
})

// ── tool-result images are read via readImageRequest ─────────────────────────

test('tool-result image is prepared via readImageRequest', async () => {
  const msgs = [
    toolMsg('call-1', [textBlock('screenshot'), imageBlock('tool-img')])
  ]
  const store = makeStore({ 'tool-img': {} })
  const result = await prepareRequestImages({
    messages: msgs, attachmentStore: store, signal: undefined,
    ...defaultOpts()
  })
  assert.equal(store.calls.length, 1, 'tool-result image should be read')
  const r = result.resolve(makeRef('tool-img'))
  assert.ok(r, 'tool-result image should resolve')
  assert.match(r.dataUrl, /^data:image\/png;base64,/)
})
