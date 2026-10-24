import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkHarnessBrowser } from '../tests/helpers/harness-browser.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const version = process.argv[2] ?? '0.2.1-rc.3'
assert.match(version, /^0\.(?:1\.7|2\.[01])-rc\.\d+$/, 'pass an exact supported Harness RC')
const work = await mkdtemp(join(tmpdir(), `copilot-harness-${version}-`))
const install = process.env.DSH_TEST_INSTALL ? resolve(process.env.DSH_TEST_INSTALL) : join(work, 'installation')
const home = join(work, 'home')
// No user credentials or project .env are inherited into this disposable profile.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot',
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS',
].includes(key)))
env.DSH_HOME = home
let browserServer
let success = false

async function run(command, args, phase, cwd = work) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 })
  await writeFile(join(work, `${phase}.log`), (result.stdout ?? '') + (result.stderr ?? ''))
  assert.equal(result.status, 0, `${phase} failed; see ${join(work, `${phase}.log`)}`)
  return result.stdout
}

async function port() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const selected = server.address().port
  await new Promise(resolve => server.close(resolve))
  return selected
}

async function stopServer() {
  if (!browserServer || browserServer.exitCode !== null || browserServer.signalCode !== null) return
  const exited = new Promise(resolve => browserServer.once('exit', resolve))
  browserServer.kill('SIGTERM')
  const timer = setTimeout(() => browserServer.kill('SIGKILL'), 8000)
  await exited
  clearTimeout(timer)
}

async function startServer(cli, ambient) {
  await stopServer()
  const args = [cli, 'web', '--no-open', '--port', String(await port())]
  const serverEnv = {
    ...env,
    NODE_OPTIONS: `--import=${pathToFileURL(join(root, 'tests/fixtures/github-device-flow.mjs')).href}`,
    ...(ambient ? { GITHUB_COPILOT_OAUTH_TOKEN: 'ghu_ambient_smoke_not_a_real_token' } : {}),
  }
  browserServer = spawn(process.execPath, args, { cwd: work, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  browserServer.stdout.on('data', chunk => { output += chunk })
  browserServer.stderr.on('data', chunk => { output += chunk })
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    const url = output.match(/dsh web: (http[^\s]+)/)?.[1]
    if (url) return url
    if (browserServer.exitCode !== null || browserServer.signalCode !== null) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  await writeFile(join(work, 'server.log'), output)
  throw new Error(`Harness did not become ready; see ${join(work, 'server.log')}`)
}

try {
  if (!process.env.DSH_TEST_INSTALL) {
    await mkdir(install, { recursive: true })
    await run('npm', ['install', '--prefix', install, '--ignore-scripts', '--legacy-peer-deps=false',
      '--no-audit', '--no-fund', `@deepseek-ai/dsh@${version}`], 'install-harness')
  }
  const installed = JSON.parse(await readFile(join(install, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
  assert.equal(installed.version, version)
  const cli = join(install, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  assert.equal((await run(process.execPath, [cli, '--version'], 'harness-version')).trim(), version)
  const artifacts = join(work, 'artifacts')
  await mkdir(artifacts)
  await run('npm', ['pack', '--pack-destination', artifacts], 'pack-plugin', root)
  const archive = join(artifacts, `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`)
  await run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', archive, '-w', '--ignore-scripts'], 'install-plugin')
  // Copilot tests must not be blocked by unrelated first-run DeepSeek onboarding.
  await writeFile(join(home, 'profiles/web/cordis.patch.yml'), '- id: ui-settings-models\n  config:\n    credentialOnboarding: false\n')
  const config = await run(process.execPath, [cli, 'web', '--dump-config'], 'dump-config')
  assert.match(config, /llm-github-copilot/)
  const plugin = join(home, 'profiles/web/node_modules', manifest.name)
  const pluginManifest = JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8'))
  assert.equal(pluginManifest.version, manifest.version)
  await readFile(join(plugin, 'cordis.patch.yml'))
  assert.ok((await readFile(join(plugin, 'lib/client.js'), 'utf8')).includes(`id: "${manifest.name}"`))
  const require = createRequire(join(plugin, 'lib/index.js'))
  for (const dependency of Object.keys(manifest.dependencies)) require.resolve(dependency)
  for (const ambient of [true, false]) {
    const url = await startServer(cli, ambient)
    const unauthenticated = await fetch(`${new URL(url).origin}/api/github-copilot-auth/status`)
    assert.equal(unauthenticated.status, 401, 'the shared API must enforce browser-session authentication')
    await checkHarnessBrowser(url, { ambient, artifacts: work })
    console.log(`${version}: ${ambient ? 'ambient-token sign-out warning' : 'fixture device flow and sign-out'} PASS`)
  }
  success = true
  console.log(`${version}: packed installation, configuration, dependencies, Host and browser checks PASS`)
} finally {
  await stopServer()
  if (success && !process.env.KEEP_HARNESS_TEST) await rm(work, { recursive: true, force: true })
  else console.log(`Isolated test artifacts: ${work}`)
}
