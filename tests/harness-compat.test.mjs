/**
 * Regression tests for DeepSeek Harness cross-version compatibility.
 *
 * Seam: `llmCompat()` — the single place that resolves which `@deepseek-ai/dsh-llm`
 * calling convention this adapter uses. Testing the factory (rather than the
 * module-level binding) lets one test run exercise BOTH supported Harness
 * versions, which no single `node_modules` tree can do.
 *
 * The bugs these lock down all reproduced as runtime TypeErrors under
 * `0.1.2-alpha.1` while the whole suite stayed green against `0.1.1-rc.2`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { llmCompat, prepareRequestImages } from '../lib/index.js'

// ── fake dsh-llm namespaces ──────────────────────────────────────────────────

/** The `0.1.1-rc.2` public surface this adapter touches. */
function rc2Namespace(calls = []) {
  return {
    CallId: (id) => { calls.push(['CallId', id]); return id },
    OFFLOADED_IMAGE_TEXT: '[image omitted]',
    requestImageHandleText: function (...args) {
      calls.push(['requestImageHandleText', args.length])
      const [version] = args
      return `Image ${version.attachment.attachmentId}; request image ${version.width}x${version.height}px.`
    }
  }
}

/** The `0.1.2-alpha.1` public surface this adapter touches. */
function alphaNamespace(calls = []) {
  return {
    ToolCallId: (id) => { calls.push(['ToolCallId', id]); return id },
    offloadedImageText: (ref) => `[image omitted; ${ref.attachmentId}]`,
    requestImageHandleText: (ref, version) => {
      // Reproduces the real alpha implementation's dereference order: calling
      // it with the old single-argument convention throws here.
      calls.push(['requestImageHandleText', ref.attachmentId])
      return `Image ${ref.attachmentId}; request preview ${version.width}x${version.height}px.`
    }
  }
}

const version = { attachment: { attachmentId: 'att-1' }, width: 1280, height: 720 }
const ref = { attachmentId: 'att-1', mediaType: 'image/png', bytes: 512, width: 1280, height: 720 }

// ── tool-call id branding ────────────────────────────────────────────────────

test('toolCallId uses CallId on 0.1.1-rc.2', () => {
  const calls = []
  assert.equal(llmCompat(rc2Namespace(calls)).toolCallId('call_1'), 'call_1')
  assert.deepEqual(calls, [['CallId', 'call_1']])
})

test('toolCallId uses ToolCallId on 0.1.2-alpha.1', () => {
  const calls = []
  assert.equal(llmCompat(alphaNamespace(calls)).toolCallId('call_1'), 'call_1')
  assert.deepEqual(calls, [['ToolCallId', 'call_1']])
})

// ── request-image handle signature ───────────────────────────────────────────

test('requestImageHandle passes only the version on 0.1.1-rc.2', () => {
  const calls = []
  const handle = llmCompat(rc2Namespace(calls)).requestImageHandle(ref, version)
  assert.equal(handle, 'Image att-1; request image 1280x720px.')
  assert.deepEqual(calls, [['requestImageHandleText', 1]], 'the old API must not receive the extra ref argument')
})

test('requestImageHandle passes the durable ref first on 0.1.2-alpha.1', () => {
  const calls = []
  const handle = llmCompat(alphaNamespace(calls)).requestImageHandle(ref, version)
  assert.equal(handle, 'Image att-1; request preview 1280x720px.')
  assert.deepEqual(calls, [['requestImageHandleText', 'att-1']])
})

test('requestImageHandle never calls the alpha API with the old arity', () => {
  // The alpha signature reads `version.width`; the old convention leaves that
  // argument undefined, which is exactly how the upgrade broke every image request.
  const alpha = alphaNamespace()
  assert.throws(() => alpha.requestImageHandleText(version), TypeError)
  assert.doesNotThrow(() => llmCompat(alpha).requestImageHandle(ref, version))
})

// ── offload placeholder ──────────────────────────────────────────────────────

test('offloadPlaceholder is empty on 0.1.1-rc.2, which owns the placeholder text', () => {
  assert.deepEqual(llmCompat(rc2Namespace()).offloadPlaceholder, {})
})

test('offloadPlaceholder supplies offloadedImageText on 0.1.2-alpha.1', () => {
  const { offloadPlaceholder } = llmCompat(alphaNamespace())
  assert.equal(typeof offloadPlaceholder.placeholder, 'function')
  assert.equal(offloadPlaceholder.placeholder(ref), '[image omitted; att-1]')
})

test('an offload policy built from offloadPlaceholder satisfies the alpha contract', () => {
  // The alpha `offloadRequestImagesWithPolicy` calls `policy.placeholder(ref)`
  // for every removed occurrence; a missing field threw "placeholder is not a
  // function" on the first real offload.
  const policy = { representation: 'base64', maxImages: 1, ...llmCompat(alphaNamespace()).offloadPlaceholder }
  assert.equal(typeof policy.placeholder, 'function')
})

// ── derived per-image byte limit ─────────────────────────────────────────────

function makeStore(derivedBytes) {
  return {
    async readImageRequest(imageRef) {
      return {
        variantId: `v-${imageRef.attachmentId}`,
        attachment: imageRef,
        data: new Uint8Array(derivedBytes).fill(1),
        mediaType: 'image/png',
        bytes: derivedBytes,
        width: 100,
        height: 100,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false
      }
    }
  }
}

function imageRequest(derivedBytes, maxImageBytes) {
  return prepareRequestImages({
    messages: [{
      role: 'user',
      content: [{ type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 512, width: 100, height: 100 } }],
      source: { kind: 'user' }
    }],
    model: { id: 'byte-model', vision: { maxImageBytes } },
    attachmentStore: makeStore(derivedBytes),
    overflowPolicy: 'offload-oldest',
    defaultImagePixelBudget: 4194304,
    maxInlineRequestImageBytes: 20971520,
    inlineImageOffloadByteQuantum: 10485760
  })
}

test('derived image over the published per-image limit → UNSUPPORTED_CONTENT', async () => {
  // maxBytes is a target, not a cap: the store may return a larger image when
  // no encoder-ladder quality meets the target.
  const { LlmError } = await import('@deepseek-ai/dsh-llm')
  await assert.rejects(
    imageRequest(2048, 1024),
    (err) => err instanceof LlmError
      && err.code === 'UNSUPPORTED_CONTENT'
      && err.message.includes('up to 1024 bytes')
      && err.message.includes('is 2048 bytes')
  )
})

test('derived image within the published per-image limit is kept', async () => {
  const out = await imageRequest(512, 1024)
  assert.equal(out.omitted, 0)
  assert.equal(out.resolve({ attachmentId: 'a' }).version.bytes, 512)
})
