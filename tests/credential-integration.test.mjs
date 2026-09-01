import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_OAUTH_TOKEN_ENV, grantEnterpriseDomain, grantToken, piAiGrantRecord, piAiRecordKey,
} from '../lib/index.js'
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
// ── enterprise domain ────────────────────────────────────────────────────────

/**
 * Point the device flow at a stand-in GitHub host and record the URLs the Host
 * actually called — that is the assertion: the domain reaches the wire, not
 * just the record. Installed *after* `credentialFixture`, whose own stub
 * forbids network access; the later `t.mock.method` wins.
 */
function stubDeviceFlow(t, host) {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    if (url === `https://${host}/login/device/code`) {
      return Response.json({
        device_code: 'device-code', user_code: 'TEST-CODE',
        verification_uri: `https://${host}/login/device`, interval: 1, expires_in: 60,
      })
    }
    if (url === `https://${host}/login/oauth/access_token`) return Response.json({ access_token: TOKEN })
    throw new Error(`unexpected request ${url}`)
  })
  return calls
}

test('the Web login body carries an enterprise domain into the device flow and the grant', async t => {
  const domain = 'company.ghe.com'
  const { credentials, request } = await credentialFixture(t)
  const calls = stubDeviceFlow(t, domain)
  // A URL is normalized to its bare hostname before it reaches the wire.
  const flow = await request('login', 'POST', { enterpriseDomain: `https://${domain}/some/path` })
  assert.equal(flow.authenticated, false)
  assert.equal(flow.state, 'pending')
  assert.equal(flow.enterpriseDomain, domain)
  assert.equal(flow.verificationUri, `https://${domain}/login/device`)
  await waitFor(async () => grantToken(await credentials.readRecord(KEY)) === TOKEN)
  assert.equal(grantEnterpriseDomain(await credentials.readRecord(KEY)), domain)
  assert.deepEqual(calls, [
    `https://${domain}/login/device/code`,
    `https://${domain}/login/oauth/access_token`,
  ])
  // The status the settings page renders reports the domain back.
  assert.equal((await request('status')).enterpriseDomain, domain)
})

test('a login without a domain keeps signing in against github.com', async t => {
  const { credentials, request } = await credentialFixture(t)
  const calls = stubDeviceFlow(t, 'github.com')
  const flow = await request('login', 'POST')
  assert.equal(flow.state, 'pending')
  assert.equal('enterpriseDomain' in flow, false)
  await waitFor(async () => grantToken(await credentials.readRecord(KEY)) === TOKEN)
  const record = await credentials.readRecord(KEY)
  assert.equal(grantEnterpriseDomain(record), undefined)
  assert.equal('enterpriseUrl' in record.payload, false)
  assert.deepEqual(calls, ['https://github.com/login/device/code', 'https://github.com/login/oauth/access_token'])
})

test('a malformed enterprise domain is refused before any request is made', async t => {
  const { credentials, request } = await credentialFixture(t)
  const calls = stubDeviceFlow(t, 'company.ghe.com')
  const result = await request('login', 'POST', { enterpriseDomain: 'not a host' })
  assert.equal(result.authenticated, false)
  assert.equal(result.state, 'error')
  assert.match(result.message, /Not a valid GitHub Enterprise domain/)
  assert.deepEqual(calls, [])
  assert.equal(await credentials.readRecord(KEY), undefined)
})

test('the slash command takes the enterprise domain from its raw input', async t => {
  const domain = 'company.ghe.com'
  const { credentials, command } = await credentialFixture(t)
  const calls = stubDeviceFlow(t, domain)
  const result = await command('copilot-login', { rawInput: domain })
  assert.equal(result.kind, 'success')
  assert.match(result.text, new RegExp(`https://${domain}/login/device`))
  await waitFor(async () => grantToken(await credentials.readRecord(KEY)) === TOKEN)
  assert.equal(grantEnterpriseDomain(await credentials.readRecord(KEY)), domain)
  assert.equal(calls[0], `https://${domain}/login/device/code`)
})
