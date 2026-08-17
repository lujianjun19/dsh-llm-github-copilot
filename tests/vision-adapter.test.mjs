/**
 * Unit tests for createImageResolver — the per-request attachment reader.
 * Exercises caching, AbortSignal forwarding, MIME/size/count validation, and
 * missing-service errors.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createImageResolver } from '../lib/index.js'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeRef(id, mediaType = 'image/png', bytes = 1024) {
  return { attachmentId: id, mediaType, bytes, width: 200, height: 200 }
}

function makeStore(images = {}) {
  const calls = []
  const store = {
    calls,
    async readImage(ref, signal) {
      calls.push({ id: ref.attachmentId, signal })
      const img = images[ref.attachmentId]
      if (!img) throw new Error(`unknown image: ${ref.attachmentId}`)
      // Simulate async I/O
      await new Promise(r => setImmediate(r))
      if (signal?.aborted) throw signal.reason
      return { ref: { ...ref, mediaType: img.mediaType ?? ref.mediaType }, data: img.data }
    }
  }
  return store
}

function pngData(bytes = 512) {
  return new Uint8Array(bytes).fill(1)
}

// ── basic resolution ──────────────────────────────────────────────────────────

test('resolve returns dataUrl with correct mediaType', async () => {
  const data = pngData(256)
  const store = makeStore({ img1: { data } })
  const resolver = createImageResolver(store, { id: 'm', vision: undefined }, undefined)
  const result = await resolver.resolve(makeRef('img1', 'image/png', 256))
  assert.match(result.dataUrl, /^data:image\/png;base64,/)
  assert.equal(result.mediaType, 'image/png')
  assert.equal(result.bytes, 256)
})

test('resolver uses storage-layer verified mediaType, not caller claim', async () => {
  const data = pngData(64)
  // Caller claims jpeg, storage returns png
  const store = makeStore({ img2: { data, mediaType: 'image/png' } })
  const resolver = createImageResolver(store, { id: 'm', vision: undefined }, undefined)
  const ref = makeRef('img2', 'image/jpeg', 64)
  const result = await resolver.resolve(ref)
  assert.equal(result.mediaType, 'image/png')
})

// ── caching: same attachmentId read only once ─────────────────────────────────

test('same attachmentId resolved twice → store.readImage called only once', async () => {
  const data = pngData(128)
  const store = makeStore({ imgC: { data } })
  const resolver = createImageResolver(store, { id: 'm', vision: undefined }, undefined)
  const ref = makeRef('imgC')
  const [r1, r2] = await Promise.all([resolver.resolve(ref), resolver.resolve(ref)])
  assert.equal(store.calls.length, 1)
  assert.equal(r1.dataUrl, r2.dataUrl)
})

test('different attachmentIds → store.readImage called separately', async () => {
  const store = makeStore({
    imgA: { data: pngData(64) },
    imgB: { data: pngData(128) }
  })
  const resolver = createImageResolver(store, { id: 'm', vision: undefined }, undefined)
  await resolver.resolve(makeRef('imgA'))
  await resolver.resolve(makeRef('imgB'))
  assert.equal(store.calls.length, 2)
})

// ── AbortSignal forwarding ────────────────────────────────────────────────────

test('AbortSignal is forwarded to readImage', async () => {
  const data = pngData(64)
  const store = makeStore({ imgS: { data } })
  const ac = new AbortController()
  const resolver = createImageResolver(store, { id: 'm', vision: undefined }, ac.signal)
  await resolver.resolve(makeRef('imgS'))
  assert.equal(store.calls[0].signal, ac.signal)
})

// ── missing attachment service ────────────────────────────────────────────────

test('null attachmentStore → UNSUPPORTED_CONTENT', async () => {
  const { LlmError } = await import('@deepseek-ai/dsh-llm')
  const resolver = createImageResolver(null, { id: 'm', vision: undefined }, undefined)
  await assert.rejects(
    resolver.resolve(makeRef('img-null')),
    (err) => err instanceof LlmError && err.code === 'UNSUPPORTED_CONTENT'
  )
})

test('undefined attachmentStore → UNSUPPORTED_CONTENT', async () => {
  const { LlmError } = await import('@deepseek-ai/dsh-llm')
  const resolver = createImageResolver(undefined, { id: 'm', vision: undefined }, undefined)
  await assert.rejects(
    resolver.resolve(makeRef('img-undef')),
    (err) => err instanceof LlmError && err.code === 'UNSUPPORTED_CONTENT'
  )
})

// ── MIME validation ───────────────────────────────────────────────────────────

test('MIME in allowlist passes', async () => {
  const store = makeStore({ imgMime: { data: pngData(64), mediaType: 'image/png' } })
  const model = { id: 'test-model', vision: { mediaTypes: ['image/png', 'image/jpeg'] } }
  const resolver = createImageResolver(store, model, undefined)
  const result = await resolver.resolve(makeRef('imgMime'))
  assert.equal(result.mediaType, 'image/png')
})

test('MIME not in allowlist → UNSUPPORTED_CONTENT with model id', async () => {
  const { LlmError } = await import('@deepseek-ai/dsh-llm')
  const store = makeStore({ imgGif: { data: pngData(64), mediaType: 'image/gif' } })
  const model = { id: 'strict-model', vision: { mediaTypes: ['image/png', 'image/jpeg'] } }
  const resolver = createImageResolver(store, model, undefined)
  await assert.rejects(
    resolver.resolve(makeRef('imgGif', 'image/gif', 64)),
    (err) => {
      assert.ok(err instanceof LlmError)
      assert.equal(err.code, 'UNSUPPORTED_CONTENT')
      assert.match(err.message, /strict-model/)
      assert.match(err.message, /image\/gif/)
      return true
    }
  )
})

// ── size validation ───────────────────────────────────────────────────────────

test('image within maxImageBytes passes', async () => {
  const store = makeStore({ imgSmall: { data: pngData(1000), mediaType: 'image/png' } })
  const model = { id: 'size-model', vision: { maxImageBytes: 1024 } }
  const resolver = createImageResolver(store, model, undefined)
  const result = await resolver.resolve(makeRef('imgSmall', 'image/png', 1000))
  assert.equal(result.bytes, 1000)
})

test('image exceeding maxImageBytes → UNSUPPORTED_CONTENT with byte counts', async () => {
  const { LlmError } = await import('@deepseek-ai/dsh-llm')
  const store = makeStore({ imgBig: { data: pngData(2000), mediaType: 'image/png' } })
  const model = { id: 'byte-model', vision: { maxImageBytes: 1024 } }
  const resolver = createImageResolver(store, model, undefined)
  await assert.rejects(
    resolver.resolve(makeRef('imgBig', 'image/png', 2000)),
    (err) => {
      assert.ok(err instanceof LlmError)
      assert.equal(err.code, 'UNSUPPORTED_CONTENT')
      assert.match(err.message, /byte-model/)
      assert.match(err.message, /1024/)
      assert.match(err.message, /2000/)
      return true
    }
  )
})

// ── count validation ──────────────────────────────────────────────────────────

test('images within maxImages limit pass', async () => {
  const store = makeStore({
    c1: { data: pngData(64), mediaType: 'image/png' },
    c2: { data: pngData(64), mediaType: 'image/png' }
  })
  const model = { id: 'count-model', vision: { maxImages: 2 } }
  const resolver = createImageResolver(store, model, undefined)
  await resolver.resolve(makeRef('c1'))
  await resolver.resolve(makeRef('c2'))
  // No error
})

test('exceeding maxImages → UNSUPPORTED_CONTENT with model id and counts', async () => {
  const { LlmError } = await import('@deepseek-ai/dsh-llm')
  const store = makeStore({
    d1: { data: pngData(64), mediaType: 'image/png' },
    d2: { data: pngData(64), mediaType: 'image/png' }
  })
  const model = { id: 'limit-model', vision: { maxImages: 1 } }
  const resolver = createImageResolver(store, model, undefined)
  await resolver.resolve(makeRef('d1'))
  await assert.rejects(
    resolver.resolve(makeRef('d2')),
    (err) => {
      assert.ok(err instanceof LlmError)
      assert.equal(err.code, 'UNSUPPORTED_CONTENT')
      assert.match(err.message, /limit-model/)
      assert.match(err.message, /1/)
      return true
    }
  )
})

test('same image appearing twice counts as 1 unique image', async () => {
  const store = makeStore({ same: { data: pngData(64), mediaType: 'image/png' } })
  const model = { id: 'dedup-model', vision: { maxImages: 1 } }
  const resolver = createImageResolver(store, model, undefined)
  const ref = makeRef('same')
  // First resolve: unique count = 1, within limit
  await resolver.resolve(ref)
  // Second resolve of same id: returns cache, does not increment count
  await resolver.resolve(ref)
  assert.equal(store.calls.length, 1)
})

// ── no vision limits (undefined) ─────────────────────────────────────────────

test('model without vision limits → all images accepted without constraint', async () => {
  const store = makeStore({
    any1: { data: pngData(5_000_000), mediaType: 'image/gif' },
    any2: { data: pngData(64), mediaType: 'image/webp' },
    any3: { data: pngData(64), mediaType: 'image/jpeg' }
  })
  const model = { id: 'no-limits', vision: undefined }
  const resolver = createImageResolver(store, model, undefined)
  await resolver.resolve(makeRef('any1', 'image/gif', 5_000_000))
  await resolver.resolve(makeRef('any2', 'image/webp', 64))
  await resolver.resolve(makeRef('any3', 'image/jpeg', 64))
})
