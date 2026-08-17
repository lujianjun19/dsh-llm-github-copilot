import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' })

run(process.execPath, ['scripts/build.mjs'])
run(process.execPath, ['--test', 'tests/build.test.mjs'])
run('npm', ['pack', '--dry-run', '--json'])
console.log('check complete')
