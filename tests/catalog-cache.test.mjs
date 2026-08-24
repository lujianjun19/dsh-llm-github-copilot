/**
 * Unit tests for the catalog cache TTL policy.
 *
 * Seam: catalogCacheEntry(models, now) — the pure policy that decides how long
 * a discovered catalog stays cached. A non-empty catalog is cached for the
 * normal TTL; an empty/failed catalog is cached only briefly so the next poll
 * retries quickly (fixes: models stuck at 0 after logout → re-login).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { catalogCacheEntry, CATALOG_TTL_MS, NEGATIVE_CATALOG_TTL_MS } from '../lib/index.js'

test('non-empty catalog is cached for the full TTL', () => {
  const now = 1_000_000
  const entry = catalogCacheEntry([{ id: 'gpt-4.1' }], now)
  assert.equal(entry.at, now)
  assert.equal(entry.ttl, CATALOG_TTL_MS)
  assert.deepEqual(entry.models, [{ id: 'gpt-4.1' }])
})

test('empty catalog is cached only briefly (negative TTL)', () => {
  const now = 2_000_000
  const entry = catalogCacheEntry([], now)
  assert.equal(entry.at, now)
  assert.equal(entry.ttl, NEGATIVE_CATALOG_TTL_MS)
  assert.deepEqual(entry.models, [])
})

test('negative TTL is much shorter than the positive TTL', () => {
  assert.ok(NEGATIVE_CATALOG_TTL_MS > 0, 'negative TTL must be positive')
  assert.ok(NEGATIVE_CATALOG_TTL_MS < CATALOG_TTL_MS,
    'a failed/empty catalog must expire far sooner than a good one')
})
