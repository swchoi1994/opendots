import assert from 'node:assert/strict'
import { test } from 'node:test'
import { processSecret, sessionSecret } from './deployment-session'

test('an unset or empty secret falls back to a random key, never a known or empty one', () => {
  const unset = sessionSecret({})
  const empty = sessionSecret({ DEPLOYMENT_SESSION_SECRET: '' })
  assert.match(unset, /^[0-9a-f]{64}$/)
  assert.match(empty, /^[0-9a-f]{64}$/, 'Compose passes "" for an unset variable; that must not become the key')
  assert.notEqual(unset, empty)
  assert.equal(sessionSecret({ DEPLOYMENT_SESSION_SECRET: 'configured' }), 'configured')
})

test('the random fallback is kept for the process, so a dev hot reload does not sign visitors out', () => {
  const holder: { __opendotsSessionSecret?: string } = {}
  const first = processSecret({}, holder)
  assert.match(first, /^[0-9a-f]{64}$/)
  assert.equal(processSecret({ DEPLOYMENT_SESSION_SECRET: '' }, holder), first, 're-evaluating the module reuses the same key')
  assert.equal(processSecret({ DEPLOYMENT_SESSION_SECRET: 'configured' }, holder), 'configured')
})
