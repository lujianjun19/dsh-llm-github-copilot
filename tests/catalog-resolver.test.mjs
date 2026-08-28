/**
 * Unit tests for the model-catalog resolver: cache reuse, the credential gate,
 * the static fallback, and cancellation.
 *
 * Seam: `createCatalogResolver(deps)` — transport and credentials are injected,
 * so the policy runs without a network or a live Harness context.
 *
 * Cancellation matters beyond "stop the fetch". The resolver's failure path
 * caches a fallback catalog under a short negative TTL; caching that for a
 * merely cancelled lookup would empty every model picker until the TTL expired.
 * A cancelled lookup must therefore surface and leave the cache untouched.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCatalogResolver, CATALOG_TTL_MS } from '../lib/index.js'

const MODELS = [{ id: 'gpt-4.1', name: 'GPT-4.1', capabilities: { supports: { vision: true } } }]
const listing = (models = MODELS) => ({ data: models })
const silentLogger = { warn() {} }

/**
 * Build a resolver over controllable dependencies.
 * @param {object} over - dependency overrides.
 */
function makeResolver(over = {}) {
  const calls = { fetch: [], connection: [] }
  const resolver = createCatalogResolver({
    configuredModels: () => [],
    resolveRawOAuthToken: async () => 'gho_token',
    resolveConnection: async (signal) => { calls.connection.push(signal); return { baseUrl: 'https://api', apiToken: 't' } },
    fetchModels: async (_connection, signal) => { calls.fetch.push(signal); return listing() },
    logger: silentLogger,
    name: 'llm-github-copilot',
    ...over,
  })
  return { resolver, calls }
}

// ── caching ──────────────────────────────────────────────────────────────────

test('a discovered catalog is served from cache on the next call', async () => {
  const { resolver, calls } = makeResolver()
  assert.equal((await resolver()).length, 1)
  assert.equal((await resolver()).length, 1)
  assert.equal(calls.fetch.length, 1, 'second call must not re-interrogate the endpoint')
})

test('invalidate() forces the next call to re-interrogate', async () => {
  const { resolver, calls } = makeResolver()
  await resolver()
  resolver.invalidate()
  await resolver()
  assert.equal(calls.fetch.length, 2)
})

test('an expired entry is re-interrogated', async () => {
  let clock = 1_000_000
  const { resolver, calls } = makeResolver({ now: () => clock })
  await resolver()
  clock += CATALOG_TTL_MS + 1
  await resolver()
  assert.equal(calls.fetch.length, 2)
})

// ── credential gate and fallback ─────────────────────────────────────────────

test('signed out → empty catalog, and the endpoint is never interrogated', async () => {
  const { resolver, calls } = makeResolver({ resolveRawOAuthToken: async () => undefined })
  assert.deepEqual(await resolver(), [])
  assert.equal(calls.fetch.length, 0)
})

test('discovery failure falls back to the configured static catalog', async () => {
  const configured = [{ id: 'static-model' }]
  const { resolver } = makeResolver({
    configuredModels: () => configured,
    fetchModels: async () => { throw new Error('boom') },
  })
  assert.deepEqual(await resolver(), configured)
})

test('discovery failure without a static catalog advertises nothing', async () => {
  const { resolver } = makeResolver({ fetchModels: async () => { throw new Error('boom') } })
  assert.deepEqual(await resolver(), [])
})

// ── cancellation ─────────────────────────────────────────────────────────────

test('the caller signal reaches both the token exchange and the models request', async () => {
  const { resolver, calls } = makeResolver()
  const controller = new AbortController()
  await resolver(controller.signal)
  assert.equal(calls.connection[0], controller.signal)
  assert.equal(calls.fetch[0], controller.signal)
})

test('an already-aborted signal is refused before any work', async () => {
  const { resolver, calls } = makeResolver()
  await assert.rejects(resolver(AbortSignal.abort()))
  assert.equal(calls.fetch.length, 0)
})

test('a cancelled lookup surfaces instead of degrading to the fallback', async () => {
  const controller = new AbortController()
  const { resolver } = makeResolver({
    configuredModels: () => [{ id: 'static-model' }],
    fetchModels: async () => { controller.abort(); throw new Error('aborted') },
  })
  await assert.rejects(resolver(controller.signal), /aborted/)
})

test('a cancelled lookup leaves the cache untouched', async () => {
  // The regression this pins: caching the fallback for a cancelled lookup would
  // empty every model picker for the whole negative TTL.
  const controller = new AbortController()
  let fetches = 0
  const { resolver } = makeResolver({
    fetchModels: async () => {
      fetches += 1
      if (fetches === 1) { controller.abort(); throw new Error('aborted') }
      return listing()
    },
  })
  await assert.rejects(resolver(controller.signal))
  // A fresh caller must re-interrogate and get the real catalog, not a cached empty one.
  assert.equal((await resolver()).length, 1)
  assert.equal(fetches, 2)
})

test('an ordinary failure still caches the fallback', async () => {
  // Only cancellation is exempt; a genuine discovery failure keeps its short
  // negative-TTL cache so the endpoint is not hammered.
  let fetches = 0
  const { resolver } = makeResolver({
    fetchModels: async () => { fetches += 1; throw new Error('boom') },
  })
  assert.deepEqual(await resolver(), [])
  assert.deepEqual(await resolver(), [])
  assert.equal(fetches, 1)
})
