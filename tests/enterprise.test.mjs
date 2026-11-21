/**
 * GitHub Enterprise (e.g. `bbraun.ghe.com`) sign-in.
 *
 * pi-ai's Copilot provider reads a grant's `enterpriseUrl` to exchange the
 * token at `api.<host>` and to serve requests from `copilot-api.<host>`, so
 * the only things this plugin must do are: run the device flow against the
 * enterprise host, and record that host in the grant.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  Config, ENTERPRISE_URL_ENV, deviceFlowUrls, grantEnterpriseDomain, grantToken,
  normalizeEnterpriseDomain, piAiGrantRecord, pollDeviceFlow, resolveAdapterOptions, startDeviceFlow,
} from '../lib/index.js'

const TOKEN = 'ghu_' + 'x'.repeat(36)

test('enterprise URLs and bare domains normalize to the hostname pi-ai stores', () => {
  assert.equal(normalizeEnterpriseDomain('https://bbraun.ghe.com/'), 'bbraun.ghe.com')
  assert.equal(normalizeEnterpriseDomain('bbraun.ghe.com'), 'bbraun.ghe.com')
  assert.equal(normalizeEnterpriseDomain('  https://BBraun.GHE.com/login/device  '), 'bbraun.ghe.com')
})

test('blank and github.com mean no enterprise host', () => {
  for (const value of [undefined, '', '   ', 'github.com', 'https://github.com/']) {
    assert.equal(normalizeEnterpriseDomain(value), undefined, String(value))
  }
})

test('an unparseable enterprise URL fails loud', () => {
  assert.throws(() => normalizeEnterpriseDomain('https://'), /invalid GitHub Enterprise URL/)
})

test('resolveAdapterOptions carries the enterprise host only when configured', () => {
  assert.equal('enterpriseDomain' in resolveAdapterOptions({}), false)
  assert.equal(resolveAdapterOptions({ enterpriseUrl: 'https://bbraun.ghe.com/' }).enterpriseDomain, 'bbraun.ghe.com')
})

test('enterpriseUrl is a Loader-owned volatile Config field defaulting to github.com', () => {
  const config = Config({})
  assert.equal(config.enterpriseUrl.get(), '')
  assert.equal(Config({ enterpriseUrl: 'bbraun.ghe.com' }).enterpriseUrl.get(), 'bbraun.ghe.com')
  assert.equal(ENTERPRISE_URL_ENV, 'GITHUB_COPILOT_ENTERPRISE_URL')
})

test('an enterprise grant records the host as pi-ai\'s enterpriseUrl', () => {
  const record = piAiGrantRecord(TOKEN, 'bbraun.ghe.com')
  assert.deepEqual(record.payload, { type: 'oauth', refresh: TOKEN, access: '', expires: 0, enterpriseUrl: 'bbraun.ghe.com' })
  assert.equal(grantToken(record), TOKEN)
  assert.equal(grantEnterpriseDomain(record), 'bbraun.ghe.com')
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record)
})

test('a github.com grant has no enterpriseUrl member', () => {
  const record = piAiGrantRecord(TOKEN)
  assert.equal('enterpriseUrl' in record.payload, false)
  assert.equal(grantEnterpriseDomain(record), undefined)
})

test('device-flow URLs follow the host', () => {
  assert.deepEqual(deviceFlowUrls('bbraun.ghe.com'), {
    deviceCodeUrl: 'https://bbraun.ghe.com/login/device/code',
    accessTokenUrl: 'https://bbraun.ghe.com/login/oauth/access_token',
    verificationUri: 'https://bbraun.ghe.com/login/device',
  })
})

test('the device flow talks only to the enterprise host', async (t) => {
  const seen = []
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (input) => {
    const url = String(input)
    seen.push(url)
    if (url.endsWith('/login/device/code')) {
      return Response.json({ device_code: 'dc', user_code: 'AB-CD', interval: 1, expires_in: 60 })
    }
    return Response.json({ access_token: TOKEN })
  }
  const device = await startDeviceFlow('bbraun.ghe.com')
  assert.equal(device.domain, 'bbraun.ghe.com')
  assert.equal(device.verificationUri, 'https://bbraun.ghe.com/login/device')
  assert.deepEqual(await pollDeviceFlow(device), { state: 'done', token: TOKEN })
  assert.deepEqual(seen, [
    'https://bbraun.ghe.com/login/device/code',
    'https://bbraun.ghe.com/login/oauth/access_token',
  ])
})

test('without an enterprise host the device flow still targets github.com', async (t) => {
  const seen = []
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (input) => {
    seen.push(String(input))
    return Response.json({ device_code: 'dc', user_code: 'AB-CD', interval: 1, expires_in: 60 })
  }
  const device = await startDeviceFlow()
  assert.equal(device.domain, 'github.com')
  assert.equal(device.verificationUri, 'https://github.com/login/device')
  assert.deepEqual(seen, ['https://github.com/login/device/code'])
})
