import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_OAUTH_TOKEN_ENV, name, piAiRecordKey, resolveAdapterOptions } from '../lib/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const host = await readFile(resolve(root, 'src/host/12-apply.js'), 'utf8')
const readmes = await Promise.all([
  ['README.md', 'docs/USER_GUIDE.md'],
  ['README.zh.md', 'docs/USER_GUIDE.zh.md'],
].map(async ([path, guidePath]) => ({
  path,
  text: await readFile(resolve(root, path), 'utf8'),
  guidePath,
  guide: await readFile(resolve(root, guidePath), 'utf8'),
})))

// Compare executable examples, not translated prose or shell comments.
function examples(text, language) {
  return [...text.matchAll(new RegExp('```' + language + '\\n([\\s\\S]*?)```', 'g'))]
    .map(([, body]) => body.split('\n')
      .map(line => line.replace(/\s*#.*$/, '').trimEnd())
      .filter(line => line.trim().length > 0)
      .join('\n'))
}

test('English and Chinese READMEs have identical command and configuration examples', () => {
  for (const language of ['sh', 'yaml']) {
    const en = examples(readmes[0].text, language)
    const zh = examples(readmes[1].text, language)
    assert.ok(en.length > 0, `${language} examples missing`)
    assert.deepEqual(zh, en, `${language} examples differ between languages`)
  }
})

test('English and Chinese user guides have identical shell examples', () => {
  const en = examples(readmes[0].guide, 'sh')
  assert.ok(en.length > 0)
  assert.deepEqual(examples(readmes[1].guide, 'sh'), en)
})

for (const { path, text, guidePath, guide } of readmes) {
  test(`${path} requirements match the manifest`, () => {
    assert.ok(text.includes(`Node.js ≥ ${manifest.engines.node.replace(/^>=/, '')}`))
    const ranges = new Set(Object.entries(manifest.peerDependencies)
      .filter(([dependency]) => dependency.startsWith('@deepseek-ai/dsh-'))
      .map(([, range]) => range))
    assert.ok(text.includes(`(${guidePath}#`), 'README links to its localized guide')
    for (const range of ranges) assert.ok(guide.includes(`\`${range}\``), `missing Harness peer range ${range}`)
    assert.ok(guide.includes(`\`${manifest.peerDependencies['@deepseek-ai/cordis']}\``), 'Cordis peer range')
    const baselines = new Set(Object.entries(manifest.devDependencies)
      .filter(([dependency]) => dependency.startsWith('@deepseek-ai/dsh-'))
      .map(([, range]) => range.replace(/^\^/, '')))
    for (const baseline of baselines) assert.ok(text.includes(`\`${baseline}\``), `missing test baseline ${baseline}`)
  })

  test(`${path} documents the registered commands and credential configuration`, () => {
    const commands = [...host.matchAll(/cctx\.commands\.register\(\{\s*name: "([^"]+)"/g)]
      .map(([, command]) => command)
    assert.ok(commands.length > 0)
    const documented = [...text.matchAll(/^\| `(\/copilot-[a-z-]+)` \|/gm)].map(([, command]) => command)
    assert.deepEqual(documented.sort(), commands.map(command => `/${command}`).sort())
    const [config] = examples(text, 'yaml')
    assert.equal(config, [
      `- id: ${name}`,
      '  config:',
      ...Object.entries(resolveAdapterOptions({})).map(([key, value]) => `    ${key}: ${value}`),
    ].join('\n'))
    assert.ok(text.includes(`export ${DEFAULT_OAUTH_TOKEN_ENV}=`))
    assert.ok(text.includes(`\`${String(piAiRecordKey())}\``), 'consuming route record key')
    assert.doesNotMatch(config, /\binsert:/, 'configure the installed bundle without duplicating it')
  })

  test(`${path} shell examples use the published package identity and real npm scripts`, () => {
    const shell = [...examples(text, 'sh'), ...examples(guide, 'sh')].join('\n')
    assert.ok(shell.includes(`dsh plugin --profile web add ${manifest.name} -w`))
    assert.ok(shell.includes(`dsh plugin --profile web update ${manifest.name} --latest -w`))
    assert.ok(shell.includes(`dsh plugin --profile web add ${manifest.name}@X.Y.Z -w`))
    for (const [, script] of shell.matchAll(/^npm run (\S+)/gm)) {
      assert.ok(Object.hasOwn(manifest.scripts, script), `missing npm script ${script}`)
    }
  })

  test(`${path} and its user guide have valid local documentation links`, async () => {
    for (const [document, source] of [[path, text], [guidePath, guide]]) {
      for (const [, target] of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        if (/^https?:\/\//.test(target)) continue
        const [local, anchor] = target.split('#')
        const filename = local ? resolve(root, dirname(document), local) : resolve(root, document)
        assert.ok((await stat(filename)).isFile(), `${document}: missing link ${target}`)
        if (anchor) {
          const content = await readFile(filename, 'utf8')
          const headings = [...content.matchAll(/^#{1,6} (.+)$/gm)].map(([, heading]) => heading
            .toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').replace(/\s/g, '-'))
          assert.ok(headings.includes(decodeURIComponent(anchor)), `${document}: missing anchor ${target}`)
        }
      }
    }
  })
}
