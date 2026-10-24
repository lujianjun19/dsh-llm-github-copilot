import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_OAUTH_TOKEN_ENV, grantToken, piAiGrantRecord, piAiRecordKey } from '../lib/index.js'
import { credentialFixture, TOKEN, waitFor } from './helpers/credential-fixture.mjs'

const KEY = piAiRecordKey()

test('a stored reference is handed off through the real credential plane and can be signed out', async t => {
  const { credentials, command } = await credentialFixture(t, {
    seed: store => store.set(DEFAULT_OAUTH_TOKEN_ENV, TOKEN),
  })
  await waitFor(async () => grantToken(await credentials.readRecord(KEY)) === TOKEN)
  assert.match((await command('copilot-status')).text, /authenticated/)
  assert.equal((await command('copilot-logout')).kind, 'success')
  assert.equal(await credentials.readRecord(KEY), undefined)
  assert.equal(await credentials.resolve(DEFAULT_OAUTH_TOKEN_ENV), undefined)
  assert.match((await command('copilot-status')).text, /NOT signed in/)
})

test('sign-out reports the environment token that remains after deleting local credentials', async t => {
  const { credentials, command } = await credentialFixture(t, {
    layers: [{ source: 'process', values: { [DEFAULT_OAUTH_TOKEN_ENV]: TOKEN } }],
  })
  await waitFor(async () => grantToken(await credentials.readRecord(KEY)) === TOKEN
    && (await credentials.resolve(DEFAULT_OAUTH_TOKEN_ENV))?.source === 'file')
  const result = await command('copilot-logout')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /local.*removed/i)
  assert.match(result.text, /GITHUB_COPILOT_OAUTH_TOKEN.*still supplies a token/)
  assert.match(result.text, /restart DSH/)
  assert.doesNotMatch(result.text, /signed out;/)
  assert.equal(await credentials.readRecord(KEY), undefined)
  assert.equal((await credentials.resolve(DEFAULT_OAUTH_TOKEN_ENV)).source, 'env')
  const status = await command('copilot-status')
  assert.match(status.text, /still supplies a token/)
  assert.doesNotMatch(status.text, /Credential published/)
  assert.ok(!JSON.stringify([result, status]).includes(TOKEN), 'never expose a token in command output')
})

test('Web logout and later status agree when a customized .env reference remains', async t => {
  const ref = 'MY_COPILOT_TOKEN'
  const { credentials, request } = await credentialFixture(t, {
    ref,
    layers: [{ source: 'project-env', path: '/test/.env', values: { [ref]: TOKEN } }],
  })
  await waitFor(async () => grantToken(await credentials.readRecord(KEY)) === TOKEN
    && (await credentials.resolve(ref))?.source === 'file')
  const logout = await request('logout', 'POST')
  const status = await request('status')
  assert.equal(logout.authenticated, true, 'a remaining token must not be represented as fully signed out')
  assert.equal(logout.credentialRemaining, true)
  assert.equal(logout.credential, ref)
  assert.deepEqual(status, logout)
  assert.ok(!JSON.stringify(status).includes(TOKEN))
  assert.deepEqual(await request('login', 'POST'), status, 'do not start another flow while the reference supplies a token')
})

test('an existing consuming-route grant is not overwritten by an older reference', async t => {
  const grant = { ...piAiGrantRecord('ghu_existing_grant'), payload: {
    type: 'oauth', refresh: 'ghu_existing_grant', access: 'already_exchanged', expires: 123,
  } }
  const { credentials, command } = await credentialFixture(t, {
    seed: async store => {
      await store.set(DEFAULT_OAUTH_TOKEN_ENV, TOKEN)
      await store.modifyRecord(KEY, async () => grant)
    },
  })
  await command('copilot-status')
  // A later public write drains the provider's serialized mutations before the
  // read, so an incorrectly queued adoption cannot escape the assertion.
  await credentials.set('UNRELATED_TEST_REF', 'unrelated')
  assert.deepEqual(await credentials.readRecord(KEY), grant)
})
