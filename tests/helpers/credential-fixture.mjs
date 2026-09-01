import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { Config, apply, DEFAULT_OAUTH_TOKEN_ENV } from '../../lib/index.js'

export const TOKEN = 'ghu_not_a_real_token_for_credential_tests'

export async function waitFor(predicate) {
  const deadline = Date.now() + 3000
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, 'credential state did not settle')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Real Harness services, isolated file, and a launch snapshot containing no user secrets. */
export async function credentialFixture(t, { layers = [], ref = DEFAULT_OAUTH_TOKEN_ENV, seed } = {}) {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No network expected in credential-plane tests') })
  const dir = await mkdtemp(join(tmpdir(), 'copilot-credentials-'))
  const ctx = new Context()
  const fibers = []
  t.after(async () => {
    try { for (const fiber of fibers.reverse()) await fiber.dispose() }
    finally { await rm(dir, { recursive: true, force: true }) }
  })
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot(layers))
  // Capture the host command boundary; importing the full command runtime would
  // pull in Agent/attachment/LLM services unrelated to credential handoff.
  const routes = new Map()
  ctx.provide('connection', { fetch: { register(route) {
    routes.set(route.path, route)
    return async () => { routes.delete(route.path) }
  } } })
  const commands = new Map()
  ctx.provide('commands', {
    register(definition) {
      commands.set(definition.name, definition)
      return () => commands.delete(definition.name)
    },
  })
  const store = ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  fibers.push(store)
  await store
  await seed?.(ctx.credentials)
  const plugin = ctx.plugin(child => apply(child, Config({ oauthTokenEnv: ref })))
  fibers.push(plugin)
  await plugin
  const command = async (name, invocation = {}) => {
    const definition = commands.get(name)
    assert.ok(definition, `missing command ${name}`)
    return definition.handler(invocation)
  }
  const request = async (action, method = 'GET', body) => {
    const route = routes.get(`/api/github-copilot-auth/${action}`)
    assert.ok(route, `missing Web route ${action}`)
    const response = await route.fetch(new Request(`http://localhost${route.path}`, {
      method,
      ...body === undefined ? {} : {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    }))
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    return payload.value
  }
  return { ctx, credentials: ctx.credentials, command, request, ref }
}
