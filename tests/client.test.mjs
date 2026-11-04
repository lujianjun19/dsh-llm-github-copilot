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
        register: (options, component) => { components.set(`${options.name}:${options.id}`, component); return () => {} },
      },
    })
    assert.ok(components.has('settings.section:github-copilot'))
    renderToStaticMarkup(React.createElement(components.get('settings.section:github-copilot')))
  })
}

/** Just enough DOM for the legacy navigation-icon fallback. */
function fakeDom() {
  const node = (tag, parent) => {
    const element = {
      tag, parent, dataset: {}, attributes: new Map(), children: [],
      get isConnected() { return this.parent !== undefined && this.parent.children.includes(this) },
      setAttribute(name, value) { this.attributes.set(name, value) },
      getAttribute(name) { return this.attributes.get(name) ?? null },
      append(child) { child.parent = this; this.children.push(child) },
      replaceWith(next) {
        const index = this.parent.children.indexOf(this)
        this.parent.children[index] = next
        next.parent = this.parent
        this.parent = undefined
      },
    }
    parent?.children.push(element)
    return element
  }
  const button = node('button')
  button.textContent = 'GitHub Copilot'
  const original = node('svg', button)
  original.setAttribute('class', 'navIcon')
  button.querySelector = () => button.children.find(child => child.tag === 'svg') ?? null
  const observers = []
  return {
    button, original, observers,
    document: {
      body: {},
      querySelectorAll: () => [button],
      createElementNS: (_ns, tag) => node(tag),
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this) }
      observe() {}
      disconnect() { observers.splice(observers.indexOf(this), 1) }
    },
  }
}

function loadClient(globals = {}) {
  let client
  const primitives = {
    Button: () => null, Input: () => null, StateDot: () => null, Modal: () => null,
    RiskConfirmation: () => null, writeClipboard: async () => true,
  }
  vm.runInNewContext(source, {
    ...globals,
    window: { __ModuleLoader__: { load(module) {
      client = module.factory(name => name === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : require(name))
    } } },
  })
  return client
}

function slotHarness() {
  const disposers = []
  const declared = new Map()
  const registrations = new Map()
  const ctx = {
    locale: { register: () => () => {}, getSnapshot: () => ({ active: 'en', revision: 0 }), subscribe: () => () => {} },
    effect(execute) { disposers.push(execute()) },
    on() {},
    remote: { $on: () => () => {} },
    commandUi: { decorate: () => () => {} },
    slots: {
      inject(name, setup) { declared.set(name, setup) },
      register(options, component) {
        const key = `${options.name}:${options.id}`
        registrations.set(key, component)
        return () => { registrations.delete(key) }
      },
    },
  }
  /** Run one declaration lifetime the way ui-renderer does. */
  const declare = name => declared.get(name)()
  return { ctx, declared, declare, registrations, dispose: () => { for (const d of disposers.reverse()) d?.() } }
}

test('the settings.section.icon slot supplies the Copilot glyph for the matching section', () => {
  const dom = fakeDom()
  const client = loadClient(dom)
  const harness = slotHarness()
  client.apply(harness.ctx)
  assert.ok(harness.declared.has('settings.section.icon'))
  const retire = harness.declare('settings.section.icon')
  const Icon = harness.registrations.get('settings.section.icon:github-copilot')
  assert.ok(Icon, 'icon registered under the settings.section id')
  const markup = renderToStaticMarkup(React.createElement(Icon, { size: 20, active: true }))
  assert.match(markup, /^<svg data-github-copilot-icon="true" width="20" height="20" viewBox="0 0 16 16"/)
  assert.equal((markup.match(/<path /g) ?? []).length, 2)
  retire()
  assert.equal(harness.registrations.has('settings.section.icon:github-copilot'), false)
  harness.dispose()
})

test('the legacy navigation glyph yields to the icon slot and restores React\'s node', () => {
  const dom = fakeDom()
  const client = loadClient(dom)
  const harness = slotHarness()
  client.apply(harness.ctx)
  // Older shells never declare the icon slot: the DOM fallback swaps the glyph.
  const legacy = dom.button.querySelector()
  assert.notEqual(legacy, dom.original)
  assert.equal(legacy.dataset.githubCopilotIcon, 'true')
  assert.equal(legacy.getAttribute('class'), 'navIcon')
  // A declaring shell restores React's own node before the slot registers.
  const retire = harness.declare('settings.section.icon')
  assert.equal(dom.button.querySelector(), dom.original)
  for (const observer of dom.observers) observer.callback()
  assert.equal(dom.button.querySelector(), dom.original, 'suspended fallback leaves the node alone')
  // Collapse of the declaration resumes the fallback.
  retire()
  assert.equal(dom.button.querySelector().dataset.githubCopilotIcon, 'true')
  harness.dispose()
  assert.equal(dom.button.querySelector(), dom.original, 'unload restores the shell glyph')
  assert.equal(dom.observers.length, 0)
})
