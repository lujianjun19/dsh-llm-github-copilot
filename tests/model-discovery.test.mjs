import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

test('model discovery refreshes an empty catalog after credential reference-updated', async () => {
  let credential
  const listeners = new Map()
  const discoveries = new Map()
  let replacements = 0
  const ctx = {
    logger: { warn() {}, error() {}, info() {} },
    get(service) {
      if (service === 'credentials') {
        return {
          async resolve() {
            return credential
          }
        }
      }
      return void 0
    },
    on(event, listener) {
      listeners.set(event, listener)
    },
    effect() {},
    inject() {},
    llm: {
      registerConfigurableProviders() {},
      registerAdapter() {
        return {
          replace() {
            replacements += 1
          }
        }
      },
      registerModelDiscovery(namespace, discovery) {
        discoveries.set(namespace, discovery)
      }
    }
  }

  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (url.includes('/copilot_internal/v2/token')) {
      return {
        ok: true,
        async json() {
          return {
            token: 'copilot-api-token',
            expires_at: Date.now() / 1000 + 1800,
            endpoints: { api: 'https://api.githubcopilot.com' }
          }
        }
      }
    }
    if (url.endsWith('/models')) {
      return {
        ok: true,
        async json() {
          return { data: [{ id: 'gpt-5-mini', name: 'GPT-5 mini' }] }
        }
      }
    }
    throw new Error(`unexpected request: ${url}`)
  }

  try {
    apply(ctx, { models: [] })
    const discovery = [...discoveries.values()][0]
    assert.deepEqual(await discovery({}), [])

    credential = { value: 'ghu_test' }
    listeners.get('credentials/reference-updated')?.('GITHUB_COPILOT_OAUTH_TOKEN')

    assert.deepEqual(await discovery({}), [{ id: 'gpt-5-mini', name: 'GPT-5 mini', inputModalities: ['text'] }])
    assert.equal(replacements, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})
