import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lib = join(root, 'lib')

async function concatenate(sourceDir, output) {
  const names = (await readdir(sourceDir))
    .filter(name => name.endsWith('.js'))
    .sort((a, b) => a.localeCompare(b, 'en'))
  if (names.length === 0) throw new Error(`no source fragments in ${sourceDir}`)
  const content = (await Promise.all(names.map(name => readFile(join(sourceDir, name), 'utf8')))).join('')
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, content)
  return { output, names, bytes: Buffer.byteLength(content) }
}

const host = await concatenate(join(root, 'src/host'), join(lib, 'index.js'))
const client = await concatenate(join(root, 'src/client'), join(lib, 'client.js'))

for (const artifact of [host.output, client.output]) {
  execFileSync(process.execPath, ['--check', artifact], { stdio: 'inherit' })
}

console.log(`built host:   ${host.names.length} fragments, ${host.bytes} bytes`)
console.log(`built client: ${client.names.length} fragments, ${client.bytes} bytes`)
