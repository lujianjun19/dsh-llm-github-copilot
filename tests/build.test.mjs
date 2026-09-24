import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Build-time replacements applied to client bundle (mirrors scripts/build.mjs)
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const CLIENT_REPLACEMENTS = { '__PLUGIN_VERSION__': pkg.version }

async function fragments(face) {
  const dir = join(root, 'src', face)
  const names = (await readdir(dir)).filter(name => name.endsWith('.js')).sort((a, b) => a.localeCompare(b, 'en'))
  const values = await Promise.all(names.map(async name => ({ name, text: await readFile(join(dir, name), 'utf8') })))
  return values
}

test('ordered source fragments exactly reproduce release artifacts', async () => {
  for (const [face, artifact, replacements] of [
    ['host', 'index.js', {}],
    ['client', 'client.js', CLIENT_REPLACEMENTS]
  ]) {
    let source = (await fragments(face)).map(value => value.text).join('')
    for (const [placeholder, value] of Object.entries(replacements)) {
      source = source.replaceAll(placeholder, value)
    }
    assert.equal(source, await readFile(join(root, 'lib', artifact), 'utf8'), face)
  }
})

test('source remains split into bounded logical files', async () => {
  const host = await fragments('host')
  const client = await fragments('client')
  // Floors guard against collapsing the source into one file; they are not a
  // target. The host floor dropped from 12 when ADR-0002 removed the adapter,
  // both serializers, the stream translation, and the image pipeline.
  assert.ok(host.length >= 6, `host collapsed to ${host.length} fragments`)
  assert.ok(client.length >= 10, `client collapsed to ${client.length} fragments`)
  for (const file of [...host, ...client]) {
    const lines = file.text.split('\n').length
    assert.ok(lines <= 450, `${file.name} grew to ${lines} lines; split it before adding more behavior`)
  }
})

test('English and Chinese dictionaries have matching keys', async () => {
  const source = await readFile(join(root, 'src/client/01-i18n.js'), 'utf8')
  const block = name => source.split(`const ${name} = {`, 2)[1]
    .split(name === 'EN' ? '    const ZH = {' : '\n\n', 1)[0]
  const keys = body => new Set([...body.matchAll(/^      ([A-Za-z][A-Za-z0-9]*):/gm)].map(match => match[1]))
  const en = keys(block('EN'))
  const zh = keys(block('ZH'))
  assert.deepEqual([...en].sort(), [...zh].sort())
  assert.ok(en.size >= 30)
})

test('manifest exposes both Host and Web client release faces', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@lujianjun19/dsh-llm-github-copilot')
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  assert.equal(manifest.exports['.'].default, './lib/index.js')
  assert.equal(manifest.exports['./client'].default, './lib/client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  for (const dependency of [
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-commands',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-settings-general',
  ]) assert.ok(manifest.dsh.client.inject.includes(dependency), dependency)
  assert.ok(!manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-runtime'))
  for (const [dependency, range] of Object.entries(manifest.peerDependencies)) {
    if (!dependency.startsWith('@deepseek-ai/dsh-')) continue
    assert.equal(range, '^0.1.7-rc.1', dependency)
    assert.equal(manifest.devDependencies[dependency], range, `${dependency} development range`)
  }
  assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], '^4.0.4')
  assert.equal(manifest.devDependencies['@deepseek-ai/cordis'], '^4.0.4')
  assert.equal(manifest.dependencies['@deepseek-ai/cosmokit'], '~1.8.5')
  assert.equal(manifest.dependencies['@deepseek-ai/schemastery'], '^3.18.4')
  const deploy = await readFile(join(root, 'scripts', 'deploy.mjs'), 'utf8')
  assert.match(deploy, /bundledDeps = \['undici', '@deepseek-ai\/cosmokit', '@deepseek-ai\/schemastery'\]/)
})

test('Host uses the 0.1.7 volatile configuration and settings-presentation APIs', async () => {
  const schema = await readFile(join(root, 'src', 'host', '02-schema.js'), 'utf8')
  const apply = await readFile(join(root, 'src', 'host', '12-apply.js'), 'utf8')
  assert.match(schema, /oauthTokenEnv: z\.string\(\)\.role\("credential-ref"\)\.default\(DEFAULT_OAUTH_TOKEN_ENV\)\.volatile\(\)/)
  assert.match(apply, /config\.oauthTokenEnv\.get\(\)/)
  assert.match(apply, /settingsCtx\.settings\.configure\(\{ auto: false \}, ctx\.fiber\)/)
  assert.doesNotMatch(apply, /installSection/)
})

test('the Web OAuth routes use the authenticated shared /api channel, not raw webServer', async () => {
  const apply = await readFile(join(root, 'src', 'host', '12-apply.js'), 'utf8')
  assert.match(apply, /ctx\.inject\(\["connection"\], \(cctx\) => \{/)
  assert.match(apply, /cctx\.connection\.fetch\.register\(\{\s*\n\s*path: "\/api\/github-copilot-auth\/status",\s*\n\s*methods: \["GET"\]/)
  assert.match(apply, /path: "\/api\/github-copilot-auth\/login",\s*\n\s*methods: \["POST"\]/)
  assert.match(apply, /path: "\/api\/github-copilot-auth\/logout",\s*\n\s*methods: \["POST"\]/)
  assert.doesNotMatch(apply, /ctx\.inject\(\["webServer"\]/)
  assert.doesNotMatch(apply, /wctx\.webServer\.register/)
})

test('Web client uses the API gateway and observes credential-reference commits', async () => {
  const api = await readFile(join(root, 'src', 'client', '01-i18n.js'), 'utf8')
  const source = await readFile(join(root, 'src', 'client', '10-apply.js'), 'utf8')
  assert.match(api, /const API = "\/api\/github-copilot-auth"/)
  assert.match(source, /ctx\.remote\.\$on\("credentials\/reference-updated"/)
  assert.doesNotMatch(source, /credentials\/updated/)
})

test('settings navigation uses the official Primer Copilot octicon path', async () => {
  const source = await readFile(join(root, 'src/client/09-settings-nav-icon.js'), 'utf8')
  assert.match(source, /0-\.765-\.123-1\.242-\.37-1\.554/)
  assert.match(source, /dataset\.githubCopilotIcon/)
  assert.match(source, /fill", "currentColor"/)
})

test('repository contains no endpoint-DLP sidecar files', async () => {
  const walk = async dir => {
    const found = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'dist') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) found.push(...await walk(path))
      else if (entry.name.includes(':sec.endpointdlp')) found.push(path)
    }
    return found
  }
  assert.deepEqual(await walk(root), [])
})
