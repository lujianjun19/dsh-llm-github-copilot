import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const require = createRequire(import.meta.url)
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

for (const [locale, closeLabel] of [['en', 'Close'], ['zh', '关闭']]) {
  test(`settings supplies the required localized close label (${locale})`, () => {
    let client
    const components = new Map()
    const atom = tag => ({ children }) => React.createElement(tag, null, children)
    // The external Harness primitive boundary requires this label even when
    // the confirmation is closed; a missing prop must fail without a browser.
    const primitives = {
      Button: atom('button'), Input: atom('input'), StateDot: atom('span'),
      Modal: atom('section'), writeClipboard: async () => true,
      RiskConfirmation: props => {
        assert.equal(props.closeLabel, closeLabel)
        return null
      },
    }
    vm.runInNewContext(source, {
      window: { __ModuleLoader__: { load(module) {
        client = module.factory(name => name === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : require(name))
      } } },
    })
    client.apply({
      locale: { getSnapshot: () => ({ active: locale, revision: 0 }), subscribe: () => () => {} },
      effect() {}, on() {},
      slots: {
        inject: (_name, setup) => setup(),
        register: (options, component) => { components.set(options.id, component); return () => {} },
      },
    })
    assert.ok(components.has('github-copilot'))
    renderToStaticMarkup(React.createElement(components.get('github-copilot')))
  })
}
