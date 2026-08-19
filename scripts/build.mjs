import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lib = join(root, 'lib')

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const PLUGIN_VERSION = pkg.version

async function concatenate(sourceDir, output, replacements = {}) {
  const names = (await readdir(sourceDir))
    .filter(name => name.endsWith('.js'))
    .sort((a, b) => a.localeCompare(b, 'en'))
  if (names.length === 0) throw new Error(`no source fragments in ${sourceDir}`)
  let content = (await Promise.all(names.map(name => readFile(join(sourceDir, name), 'utf8')))).join('')
  for (const [placeholder, value] of Object.entries(replacements)) {
    content = content.replaceAll(placeholder, value)
  }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, content)
  return { output, names, bytes: Buffer.byteLength(content) }
}

const host = await concatenate(join(root, 'src/host'), join(lib, 'index.js'))
const client = await concatenate(join(root, 'src/client'), join(lib, 'client.js'), {
  '__PLUGIN_VERSION__': PLUGIN_VERSION
})

for (const artifact of [host.output, client.output]) {
  execFileSync(process.execPath, ['--check', artifact], { stdio: 'inherit' })
}

console.log(`built host:   ${host.names.length} fragments, ${host.bytes} bytes`)
console.log(`built client: ${client.names.length} fragments, ${client.bytes} bytes`)
