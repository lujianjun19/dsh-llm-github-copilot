/**
 * Regression test: the plugin must listen for the current Harness credentials
 * event name.
 *
 * Harness 0.1.1-rc.2 renamed the event from `credentials/updated` to
 * `credentials/reference-updated`. The plugin's cache-invalidation listener
 * must use the new name; otherwise credential changes (login, logout, external
 * edits) never clear the exchange/catalog caches and the model picker stays
 * empty until the TTL expires.
 *
 * Seam: CREDENTIALS_EVENT exported from lib/index.js — the single source of
 * truth for the event name used in ctx.on() inside apply().
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { CREDENTIALS_EVENT } from '../lib/index.js'

test('CREDENTIALS_EVENT is the current Harness event name (credentials/reference-updated)', () => {
  assert.equal(
    CREDENTIALS_EVENT,
    'credentials/reference-updated',
    'must use the current Harness 0.1.1-rc.2 event name, not the old credentials/updated'
  )
})

test('CREDENTIALS_EVENT is not the legacy name that no longer fires in Harness 0.1.1-rc.2', () => {
  assert.notEqual(CREDENTIALS_EVENT, 'credentials/updated')
})
