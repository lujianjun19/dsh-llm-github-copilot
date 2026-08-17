/**
 * Unit tests for GitHub /models vision-capability parsing.
 * These tests exercise readModelsListing() exported from lib/index.js.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readModelsListing } from '../lib/index.js'

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal raw model entry accepted by readModelsListing. */
function rawModel(id, caps = {}) {
  return {
    id,
    name: id,
    capabilities: {
      type: 'chat',
      supports: {},
      limits: {},
      ...caps
    },
    supported_endpoints: ['/chat/completions']
  }
}

function findEntry(listing, id) {
  return listing.find(e => e.id === id)
}

// ── vision capability detection ───────────────────────────────────────────────

test('supports.vision=true → inputModalities includes image', () => {
  const body = {
    data: [rawModel('gpt-4.1', { supports: { vision: true } })]
  }
  const models = readModelsListing(body)
  const entry = findEntry(models, 'gpt-4.1')
  assert.ok(entry, 'entry must exist')
  assert.deepEqual(entry.inputModalities, ['text', 'image'])
})

test('supports.vision=false → text only', () => {
  const body = {
    data: [rawModel('gpt-4o', { supports: { vision: false } })]
  }
  const models = readModelsListing(body)
  const entry = findEntry(models, 'gpt-4o')
  assert.deepEqual(entry.inputModalities, ['text'])
})

test('supports.vision absent → text only, even when limits.vision present', () => {
  const body = {
    data: [rawModel('some-model', {
      supports: {},
      limits: {
        vision: { max_prompt_image_size: 1048576, max_prompt_images: 1 }
      }
    })]
  }
  const models = readModelsListing(body)
  const entry = findEntry(models, 'some-model')
  assert.deepEqual(entry.inputModalities, ['text'])
  assert.equal(entry.vision, undefined)
})

test('supports.vision=true but no limits.vision → vision entry without sub-limits', () => {
  const body = {
    data: [rawModel('visual-model', { supports: { vision: true }, limits: {} })]
  }
  const models = readModelsListing(body)
  const entry = findEntry(models, 'visual-model')
  assert.deepEqual(entry.inputModalities, ['text', 'image'])
  assert.equal(entry.vision, undefined)
})

// ── vision limit mapping ──────────────────────────────────────────────────────

test('vision limits correctly mapped from raw fields', () => {
  const body = {
    data: [rawModel('gpt-4.1-vision', {
      supports: { vision: true },
      limits: {
        vision: {
          max_prompt_image_size: 3145728,
          max_prompt_images: 1,
          supported_media_types: ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
        }
      }
    })]
  }
  const models = readModelsListing(body)
  const entry = findEntry(models, 'gpt-4.1-vision')
  assert.ok(entry.vision)
  assert.equal(entry.vision.maxImageBytes, 3145728)
  assert.equal(entry.vision.maxImages, 1)
  assert.deepEqual(entry.vision.mediaTypes, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
})

test('duplicate MIME types in supported_media_types are deduplicated', () => {
  const body = {
    data: [rawModel('dup-model', {
      supports: { vision: true },
      limits: {
        vision: {
          supported_media_types: ['image/png', 'image/png', 'image/jpeg']
        }
      }
    })]
  }
  const models = readModelsListing(body)
  const entry = findEntry(models, 'dup-model')
  assert.deepEqual(entry.vision.mediaTypes, ['image/png', 'image/jpeg'])
})

test('invalid limit fields (negative, non-integer, non-string MIME) are ignored', () => {
  const body = {
    data: [rawModel('bad-limits', {
      supports: { vision: true },
      limits: {
        vision: {
          max_prompt_image_size: -1,    // invalid: negative
          max_prompt_images: 1.5,       // invalid: non-integer
          supported_media_types: [42, '', 'image/png']  // only 'image/png' valid
        }
      }
    })]
  }
  const models = readModelsListing(body)
  const entry = findEntry(models, 'bad-limits')
  assert.equal(entry.vision.maxImageBytes, undefined)
  assert.equal(entry.vision.maxImages, undefined)
  assert.deepEqual(entry.vision.mediaTypes, ['image/png'])
})

test('zero values for limits are filtered out', () => {
  const body = {
    data: [rawModel('zero-limits', {
      supports: { vision: true },
      limits: {
        vision: {
          max_prompt_image_size: 0,
          max_prompt_images: 0,
          supported_media_types: ['image/png']
        }
      }
    })]
  }
  const models = readModelsListing(body)
  const entry = findEntry(models, 'zero-limits')
  assert.equal(entry.vision?.maxImageBytes, undefined)
  assert.equal(entry.vision?.maxImages, undefined)
})

test('empty supported_media_types produces no mediaTypes field', () => {
  const body = {
    data: [rawModel('empty-mimes', {
      supports: { vision: true },
      limits: {
        vision: { supported_media_types: [] }
      }
    })]
  }
  const models = readModelsListing(body)
  const entry = findEntry(models, 'empty-mimes')
  assert.equal(entry.vision?.mediaTypes, undefined)
})

// ── no name-based inference ───────────────────────────────────────────────────

test('model named "gpt-4-vision-preview" without supports.vision stays text-only', () => {
  const body = {
    data: [rawModel('gpt-4-vision-preview', { supports: {} })]
  }
  const models = readModelsListing(body)
  const entry = findEntry(models, 'gpt-4-vision-preview')
  assert.deepEqual(entry.inputModalities, ['text'])
})

test('model with "vision" in display_name without supports.vision stays text-only', () => {
  const body = {
    data: [{
      id: 'some-vision-model',
      display_name: 'My Vision Model',
      capabilities: {
        type: 'chat',
        supports: {},
        limits: {}
      },
      supported_endpoints: ['/chat/completions']
    }]
  }
  const models = readModelsListing(body)
  const entry = findEntry(models, 'some-vision-model')
  assert.deepEqual(entry.inputModalities, ['text'])
})

// ── mixed catalog ─────────────────────────────────────────────────────────────

test('mixed catalog: vision and text-only models coexist correctly', () => {
  const body = {
    data: [
      rawModel('gpt-4.1', { supports: { vision: true }, limits: { vision: { max_prompt_images: 2 } } }),
      rawModel('gpt-4o-mini', { supports: { vision: false } }),
      rawModel('claude-sonnet-4.5', { supports: {} })
    ]
  }
  const models = readModelsListing(body)

  const gpt41 = findEntry(models, 'gpt-4.1')
  assert.deepEqual(gpt41.inputModalities, ['text', 'image'])
  assert.equal(gpt41.vision.maxImages, 2)

  const mini = findEntry(models, 'gpt-4o-mini')
  assert.deepEqual(mini.inputModalities, ['text'])
  assert.equal(mini.vision, undefined)

  const claude = findEntry(models, 'claude-sonnet-4.5')
  assert.deepEqual(claude.inputModalities, ['text'])
})
