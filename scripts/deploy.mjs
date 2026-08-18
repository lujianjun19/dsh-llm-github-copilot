import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const dshHome = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const parent = join(dshHome, 'profiles', 'web', 'node_modules', '@lujianjun19')
const target = join(parent, 'dsh-llm-github-copilot')
const stage = join(parent, `.dsh-llm-github-copilot.deploy-${process.pid}`)
const backupRoot = join(dshHome, 'plugin-backups', 'dsh-llm-github-copilot')
const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')
const backup = join(backupRoot, `v${manifest.version}-${stamp}`)
const releaseEntries = ['package.json', 'LICENSE', 'README.md', 'README.zh.md', 'AGENTS.md', 'CHANGELOG.md', 'docs', 'lib']
// Runtime dependencies bundled from local node_modules (avoids network on deploy).
// Keep in sync with `dependencies` in package.json (exclude peerDependencies and devDependencies).
const bundledDeps = ['undici', 'eventsource-parser', '@deepseek-ai/schemastery']

const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' })
const exists = async path => stat(path).then(() => true, error => {
  if (error?.code === 'ENOENT') return false
  throw error
})

run(process.execPath, ['scripts/build.mjs'])
run(process.execPath, ['--test', 'tests/build.test.mjs'])

await mkdir(parent, { recursive: true })
await mkdir(backupRoot, { recursive: true })
await rm(stage, { recursive: true, force: true })
await mkdir(stage)
for (const entry of releaseEntries) {
  await cp(join(root, entry), join(stage, entry), { recursive: true, force: true })
}
await mkdir(join(stage, 'node_modules'), { recursive: true })
for (const dep of bundledDeps) {
  const src = join(root, 'node_modules', dep)
  if (!await exists(src)) {
    throw new Error(`Bundled dependency not found: ${dep}. Run 'npm install' first.`)
  }
  await cp(src, join(stage, 'node_modules', dep), { recursive: true, force: true })
}

let movedCurrent = false
try {
  if (await exists(target)) {
    await rename(target, backup)
    movedCurrent = true
  }
  await rename(stage, target)
} catch (error) {
  await rm(stage, { recursive: true, force: true })
  if (movedCurrent && !(await exists(target)) && await exists(backup)) await rename(backup, target)
  throw error
}

const backups = (await readdir(backupRoot, { withFileTypes: true }))
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort((a, b) => b.localeCompare(a, 'en'))
for (const old of backups.slice(5)) await rm(join(backupRoot, old), { recursive: true, force: true })

console.log(`deployed ${manifest.name}@${manifest.version}`)
console.log(`target: ${target}`)
if (movedCurrent) console.log(`backup: ${backup}`)
console.log('Restart `dsh web` for Host changes; hard-refresh the browser for Client changes.')
