import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildHealth } from './health'

/**
 * No network: the model catalog is always injected so these tests never
 * reach a real Ollama.
 */
const noLocalModels = async () => ({
  options: [{ id: 'default', label: 'Default (sonnet)', provider: 'default' as const, available: true }],
  defaultModel: 'sonnet',
  ollama: { host: 'http://localhost:11434', reachable: false },
})

test('buildHealth reports ok and the store kind when the store answers', async () => {
  const { httpStatus, body } = await buildHealth({
    listChannels: async () => [],
    buildModelOptions: noLocalModels,
  })
  assert.equal(httpStatus, 200)
  assert.equal(body.status, 'ok')
  assert.ok(body.store && typeof body.store === 'object')
})

test('buildHealth responds 503 and degraded when the store throws', async () => {
  const { httpStatus, body } = await buildHealth({
    listChannels: async () => {
      throw new Error('PGlite data directory is locked by pid 123')
    },
    buildModelOptions: noLocalModels,
  })
  assert.equal(httpStatus, 503)
  assert.equal(body.status, 'degraded')
  assert.ok(body.store && typeof body.store === 'object')
  assert.equal((body.store as { error?: string }).error, 'PGlite data directory is locked by pid 123')
})
