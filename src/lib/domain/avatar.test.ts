import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AVATAR_COLORS, AVATAR_SHAPES, avatarFromName, parseAvatar } from './avatar'

test('avatarFromName is deterministic and stays inside the catalogs', () => {
  const a = avatarFromName('Chief of Staff')
  assert.deepEqual(avatarFromName('Chief of Staff'), a)
  assert.ok((AVATAR_SHAPES as readonly string[]).includes(a.shape))
  assert.ok((AVATAR_COLORS as readonly string[]).includes(a.color))
  assert.notDeepEqual(avatarFromName('EA'), avatarFromName('Invoice Collector'))
})

test('parseAvatar keeps valid values and falls back per field', () => {
  assert.deepEqual(parseAvatar({ shape: 'drop', color: 'blue' }, 'x'), { shape: 'drop', color: 'blue' })
  const fallback = avatarFromName('Growth Marketer')
  assert.deepEqual(parseAvatar({ shape: 'hexagon', color: 'blue' }, 'Growth Marketer'), { shape: fallback.shape, color: 'blue' })
  assert.deepEqual(parseAvatar(undefined, 'Growth Marketer'), fallback)
})
