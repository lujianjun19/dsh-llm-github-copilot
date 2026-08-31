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
  DEFAULT_OAUTH_TOKEN_ENV, PI_AI_PROVIDER, PI_AI_RECORD_SCOPE,
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
