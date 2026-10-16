/**
 * Unit tests for the credential handoff: the record this plugin writes so the
 * harness's own Copilot route can authenticate.
 *
 * Seam: the pure helpers exported from `lib/index.js`. The record's format is
 * owned by `llm-pi-ai` (see `docs/adr/0002-narrow-to-credential-provider.md`),
 * so these tests pin the exact shape that was verified end to end against a
 * live account — a shape change upstream must fail here rather than in the
 * field, where it would leave a credential that silently authenticates nothing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  Config, DEFAULT_OAUTH_TOKEN_ENV, PI_AI_PROVIDER, PI_AI_RECORD_SCOPE, apply,
  grantModelIds, grantToken, piAiGrantRecord, piAiRecordKey, resolveAdapterOptions,
} from '../lib/index.js'

const TOKEN = 'ghu_' + 'x'.repeat(36)

// ── record address ───────────────────────────────────────────────────────────

test('the record is addressed to the consuming plugin, not to this one', () => {
  // The scope names llm-pi-ai because that plugin owns the payload format.
  assert.equal(PI_AI_RECORD_SCOPE, 'llm-pi-ai')
  assert.equal(PI_AI_PROVIDER, 'github-copilot')
  assert.equal(String(piAiRecordKey()), 'llm-pi-ai/github-copilot')
})

// ── grant shape ──────────────────────────────────────────────────────────────

test('a fresh grant carries the long-lived token and nothing else of substance', () => {
  const record = piAiGrantRecord(TOKEN)
  assert.equal(record.kind, 'grant')
  assert.deepEqual(record.payload, { type: 'oauth', refresh: TOKEN, access: '', expires: 0 })
})

test('the unexchanged markers are empty, which is what triggers the first exchange', () => {
  // The consuming route fills access/expires/availableModelIds itself; seeding
  // them with values would claim an exchange that never happened.
  const { payload } = piAiGrantRecord(TOKEN)
  assert.equal(payload.access, '')
  assert.equal(payload.expires, 0)
  assert.equal('availableModelIds' in payload, false)
})

test('the grant survives a JSON round trip, which the credential seam requires', () => {
  const record = piAiGrantRecord(TOKEN)
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record)
})

// ── reading a grant back ─────────────────────────────────────────────────────

test('grantToken reads the token this plugin wrote', () => {
  assert.equal(grantToken(piAiGrantRecord(TOKEN)), TOKEN)
})

test('grantToken survives the fields the consuming route adds on exchange', () => {
  // Observed live: access, expires, and availableModelIds are written back into
  // this same record. The token must still be readable afterwards.
  const exchanged = {
    kind: 'grant',
    payload: {
      type: 'oauth', refresh: TOKEN,
      access: 'tid=abc;exp=123;proxy-ep=proxy.business.githubcopilot.com',
      expires: 1788242805000,
      availableModelIds: ['gpt-4.1', 'gpt-5.6-luna'],
    },
  }
  assert.equal(grantToken(exchanged), TOKEN)
  assert.deepEqual(grantModelIds(exchanged), ['gpt-4.1', 'gpt-5.6-luna'])
})

test('grantToken refuses any record that is not a usable grant', () => {
  for (const record of [
    undefined,
    { kind: 'api-key', key: TOKEN },                 // wrong kind
    { kind: 'grant', payload: undefined },           // no payload
    { kind: 'grant', payload: {} },                  // no refresh
    { kind: 'grant', payload: { refresh: '' } },     // empty refresh
    { kind: 'grant', payload: { refresh: 42 } },     // non-string refresh
  ]) {
    assert.equal(grantToken(record), undefined, JSON.stringify(record))
  }
})

test('grantModelIds refuses a list that is not all strings', () => {
  for (const ids of [undefined, 'gpt-4.1', ['gpt-4.1', 7], [{}]]) {
    const record = { kind: 'grant', payload: { refresh: TOKEN, availableModelIds: ids } }
    assert.equal(grantModelIds(record), undefined, JSON.stringify(ids))
  }
})

test('grantModelIds distinguishes "none recorded" from "recorded as empty"', () => {
  // An empty list is a fact the route recorded; undefined means it has not run.
  assert.deepEqual(grantModelIds({ kind: 'grant', payload: { refresh: TOKEN, availableModelIds: [] } }), [])
  assert.equal(grantModelIds({ kind: 'grant', payload: { refresh: TOKEN } }), undefined)
})

// ── settings ─────────────────────────────────────────────────────────────────

test('the settings section resolves to just the credential reference', () => {
  assert.deepEqual(resolveAdapterOptions({}), { oauthTokenEnv: DEFAULT_OAUTH_TOKEN_ENV })
  assert.deepEqual(resolveAdapterOptions({ oauthTokenEnv: 'MY_TOKEN' }), { oauthTokenEnv: 'MY_TOKEN' })
})

test('the credential reference is a Loader-owned volatile Config field', () => {
  const config = Config({})
  assert.equal(typeof config.oauthTokenEnv.get, 'function')
  assert.equal(config.oauthTokenEnv.get(), DEFAULT_OAUTH_TOKEN_ENV)
})

test('apply configures the 0.1.7 Settings presentation without the removed installSection API', () => {
  const fiber = {}
  const calls = []
  const settings = {
    configure: (policy, owner) => {
      calls.push({ policy, owner })
      return () => {}
    },
  }
  const ctx = {
    fiber,
    logger: { error() {}, info() {}, warn() {} },
    get: () => undefined,
    on() {},
    effect(setup) { return setup() },
    inject(dependencies, callback) {
      if (dependencies.length === 1 && dependencies[0] === 'settings') {
        callback({ effect: setup => setup(), settings })
      }
    },
  }
  apply(ctx, Config({}))
  assert.deepEqual(calls, [{ policy: { auto: false }, owner: fiber }])
})

test('apply registers the Web OAuth routes on the authenticated shared /api channel, not raw webServer', async () => {
  const registered = []
  const connection = {
    fetch: {
      register: (route) => {
        registered.push(route)
        return async () => { route.disposed = true }
      },
    },
  }
  const ctx = {
    fiber: {},
    logger: { error() {}, info() {}, warn() {} },
    get: () => undefined,
    on() {},
    effect(setup) { return setup() },
    inject(dependencies, callback) {
      if (dependencies.length === 1 && dependencies[0] === 'connection') {
        callback({ effect: setup => setup(), connection })
      }
      // A composition without 'webServer' registered must not be required:
      // the plugin must never call ctx.inject(['webServer'], ...) any more.
      if (dependencies.length === 1 && dependencies[0] === 'webServer') {
        throw new Error('apply() must not inject webServer for browser-facing routes')
      }
    },
  }
  apply(ctx, Config({}))
  assert.deepEqual(registered.map(route => ({ path: route.path, methods: route.methods, requestBody: route.requestBody })), [
    { path: '/api/github-copilot-auth/status', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/github-copilot-auth/login', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/github-copilot-auth/logout', methods: ['POST'], requestBody: 'buffered' },
  ])
  for (const route of registered) assert.equal(typeof route.fetch, 'function')
  // The status route resolves without a credentials service; its Fetch handler
  // returns a real Response with the JSON shape the client expects.
  const response = await registered[0].fetch(new Request('http://host/api/github-copilot-auth/status'))
  assert.ok(response instanceof Response)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.value.authenticated, false)
  assert.equal(body.value.provider, PI_AI_PROVIDER)
})

// ── adopting an environment-supplied token ───────────────────────────────────

/**
 * A credentials service shaped like `credentials-local` before 0.2.1: a
 * reference the launching environment supplies is read-only, `describe`
 * reports it unwritable, and `set` rejects it.
 */
function readOnlyEnvCredentials(ref, value) {
  const records = new Map()
  const calls = { set: 0 }
  return {
    calls,
    records,
    readRecord: async key => records.get(String(key)),
    modifyRecord: async (key, update) => { records.set(String(key), await update(records.get(String(key)))) },
    resolve: async r => r === ref ? { value } : undefined,
    describe: async r => r === ref
      ? { configured: true, source: 'env', writable: false }
      : { configured: false, writable: true },
    set: async (r) => {
      calls.set += 1
      throw new Error(`credentials-local: "${r}" is supplied read-only by the launching environment`)
    },
  }
}

test('an environment-supplied token is adopted into the grant without writing the read-only reference', async () => {
  const credentials = readOnlyEnvCredentials(DEFAULT_OAUTH_TOKEN_ENV, TOKEN)
  const logs = { info: [], warn: [] }
  let adoption
  const ctx = {
    fiber: {},
    logger: { error() {}, info: m => logs.info.push(m), warn: m => logs.warn.push(m) },
    get: name => name === 'credentials' ? credentials : undefined,
    on() {},
    effect(setup) { return setup() },
    inject(dependencies, callback) {
      if (dependencies.length === 1 && dependencies[0] === 'credentials') {
        callback({ effect: (setup) => { adoption = setup() } })
      }
    },
  }
  apply(ctx, Config({}))
  assert.equal(typeof adoption, 'function')
  // The adoption is fire-and-forget; let its awaits settle.
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(grantToken(credentials.records.get('llm-pi-ai/github-copilot')), TOKEN)
  assert.equal(credentials.calls.set, 0)
  assert.deepEqual(logs.warn, [])
  assert.equal(logs.info.length, 1)
})
