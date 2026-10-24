// External-service fixture for the isolated Harness/browser smoke test only.
// No GitHub request or real token is used. All non-GitHub traffic is untouched.
const originalFetch = globalThis.fetch
const token = 'ghu_harness_smoke_not_a_real_token'
let polls = 0
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url === 'https://github.com/login/device/code') {
    return Response.json({
      device_code: 'smoke-device-code', user_code: 'TEST-CODE',
      verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 60,
    })
  }
  if (url === 'https://github.com/login/oauth/access_token') {
    // Leave the device code visible long enough to exercise the pending UI.
    return Response.json(++polls < 3 ? { error: 'authorization_pending' } : { access_token: token })
  }
  return originalFetch(input, init)
}
