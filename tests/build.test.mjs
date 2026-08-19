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
  assert.ok(host.length >= 12)
  assert.ok(client.length >= 10)
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
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-commands',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-primitives',
  ]) assert.ok(manifest.dsh.client.inject.includes(dependency), dependency)
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
