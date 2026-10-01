import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sessionSecret } from './deployment-session'

test('an unset or empty secret falls back to a random key, never a known or empty one', () => {
  const unset = sessionSecret({})
  const empty = sessionSecret({ DEPLOYMENT_SESSION_SECRET: '' })
  assert.match(unset, /^[0-9a-f]{64}$/)
  assert.match(empty, /^[0-9a-f]{64}$/, 'Compose passes "" for an unset variable; that must not become the key')
  assert.notEqual(unset, empty)
  assert.equal(sessionSecret({ DEPLOYMENT_SESSION_SECRET: 'configured' }), 'configured')
})
