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
    offloadedImageText: (ref, access) => {
      calls.push(['offloadedImageText', ref.attachmentId, access?.readonlyPath])
      return `[image omitted; ${ref.attachmentId}${access ? ' at ' + access.readonlyPath : ''}]`
    },
    resolveImageAttachmentAccess: (attachments, mapHostPath, ref) => {
      const hostPath = attachments.imageHostPath(ref)
      if (hostPath === undefined) return undefined
      const readonlyPath = mapHostPath(hostPath)
      return readonlyPath === undefined ? undefined : { readonlyPath }
    },
    requestImageHandleText: (ref, version, access) => {
      // Reproduces the real alpha implementation's dereference order: calling
      // it with the old single-argument convention throws here.
      calls.push(['requestImageHandleText', ref.attachmentId, access?.readonlyPath])
      return `Image ${ref.attachmentId}; request preview ${version.width}x${version.height}px.`
        + (access ? ` Normalized copy: ${access.readonlyPath}` : '')
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
  assert.deepEqual(calls, [['requestImageHandleText', 'att-1', undefined]])
})

test('requestImageHandle never calls the alpha API with the old arity', () => {
  // The alpha signature reads `version.width`; the old convention leaves that
  // argument undefined, which is exactly how the upgrade broke every image request.
  const alpha = alphaNamespace()
  assert.throws(() => alpha.requestImageHandleText(version), TypeError)
  assert.doesNotThrow(() => llmCompat(alpha).requestImageHandle(ref, version))
})

// ── offload placeholder ──────────────────────────────────────────────────────

test('offloadPlaceholderFor is empty on 0.1.1-rc.2, which owns the placeholder text', () => {
  assert.deepEqual(llmCompat(rc2Namespace()).offloadPlaceholderFor(undefined), {})
})

test('offloadPlaceholderFor supplies offloadedImageText on 0.1.2-alpha.1', () => {
  const { placeholder } = llmCompat(alphaNamespace()).offloadPlaceholderFor(undefined)
  assert.equal(typeof placeholder, 'function')
  assert.equal(placeholder(ref), '[image omitted; att-1]')
})

test('an offload policy built from offloadPlaceholderFor satisfies the alpha contract', () => {
  // The alpha `offloadRequestImagesWithPolicy` calls `policy.placeholder(ref)`
  // for every removed occurrence; a missing field threw "placeholder is not a
  // function" on the first real offload.
  const policy = {
    representation: 'base64', maxImages: 1,
    ...llmCompat(alphaNamespace()).offloadPlaceholderFor(undefined)
  }
  assert.equal(typeof policy.placeholder, 'function')
})

// ── read-only image access paths ──────────────────────────────────────

const hostBackedStore = { imageHostPath: () => '/host/objects/att-1.png' }
const mapIntoTools = (hostPath) => hostPath.replace('/host', '/workspace')

test('imageAccess resolves a read-only path on 0.1.2-alpha.1', () => {
  const access = llmCompat(alphaNamespace()).imageAccess(hostBackedStore, mapIntoTools, ref)
  assert.deepEqual(access, { readonlyPath: '/workspace/objects/att-1.png' })
})

test('imageAccess yields undefined on 0.1.1-rc.2, which has no such API', () => {
  assert.equal(llmCompat(rc2Namespace()).imageAccess(hostBackedStore, mapIntoTools, ref), undefined)
})

test('imageAccess yields undefined when the backend is not host-file-backed', () => {
  const store = { imageHostPath: () => undefined }
  assert.equal(llmCompat(alphaNamespace()).imageAccess(store, mapIntoTools, ref), undefined)
})

test('imageAccess yields undefined when no filesystem mapping exists', () => {
  assert.equal(llmCompat(alphaNamespace()).imageAccess(hostBackedStore, () => undefined, ref), undefined)
})

test('a failing path lookup degrades to no path instead of failing the request', () => {
  // An omitted image's bytes are never read, so its durable reference is never
  // otherwise validated; a throw here would turn a placeholder into a failed
  // request. The path only enriches text, so it must degrade.
  const throwing = { imageHostPath: () => { throw new Error('invalid attachment reference') } }
  assert.equal(llmCompat(alphaNamespace()).imageAccess(throwing, mapIntoTools, ref), undefined)
})

test('a resolved path reaches both the request handle and the offload placeholder', () => {
  const compat = llmCompat(alphaNamespace())
  const resolveAccess = (r) => compat.imageAccess(hostBackedStore, mapIntoTools, r)

  const handle = compat.requestImageHandle(ref, version, resolveAccess(ref))
  assert.match(handle, /Normalized copy: \/workspace\/objects\/att-1\.png/)

  const { placeholder } = compat.offloadPlaceholderFor(resolveAccess)
  assert.equal(placeholder(ref), '[image omitted; att-1 at /workspace/objects/att-1.png]')
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

// ── access resolution reaches the projection ──────────────────────────────

test('resolveImageAccess is consulted per kept image, keyed by its durable ref', async () => {
  // The compat layer decides whether the resolved path reaches the wire (it
  // does only on 0.1.2-alpha.1, and the repository builds against rc.2). What
  // the projection owns, and what this pins, is that the resolver is invoked
  // for the right durable reference.
  const seen = []
  const out = await prepareRequestImages({
    messages: [{
      role: 'user',
      content: [{ type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 512, width: 100, height: 100 } }],
      source: { kind: 'user' }
    }],
    model: { id: 'm', vision: {} },
    attachmentStore: makeStore(512),
    resolveImageAccess: (ref) => { seen.push(ref.attachmentId); return { readonlyPath: `/w/${ref.attachmentId}.png` } },
    overflowPolicy: 'offload-oldest',
    defaultImagePixelBudget: 4194304,
    maxInlineRequestImageBytes: 20971520,
    inlineImageOffloadByteQuantum: 10485760
  })
  out.resolve({ attachmentId: 'a' })
  assert.deepEqual(seen, ['a'])
})

test('an absent resolveImageAccess leaves the projection working', async () => {
  const out = await imageRequest(512, 1024)
  assert.equal(typeof out.resolve({ attachmentId: 'a' }).handle, 'string')
})
