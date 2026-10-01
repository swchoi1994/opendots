import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupScreensByTurn, type Screen } from './screen'

function screen(overrides: Partial<Screen> & { turnId: string; step: number; createdAt: number }): Screen {
  return {
    screenId: overrides.createdAt,
    channelUrl: 'bot_x',
    messageId: null,
    action: 'open',
    target: null,
    intent: null,
    url: 'https://example.com/',
    title: 'Example',
    imageUrl: null,
    annotations: [],
    flagged: false,
    ...overrides,
  }
}

test('groupScreensByTurn orders interleaved turns by start time, newest first, steps ascending within a turn', () => {
  // t1 starts, t2 starts before t1 finishes, t1 then continues.
  const t1Step1 = screen({ turnId: 't1', step: 1, createdAt: 100 })
  const t2Step1 = screen({ turnId: 't2', step: 1, createdAt: 200 })
  const t1Step2 = screen({ turnId: 't1', step: 2, createdAt: 300 })

  const grouped = groupScreensByTurn([t1Step1, t2Step1, t1Step2])

  assert.deepEqual(
    grouped.map((s) => `${s.turnId}-${s.step}`),
    ['t2-1', 't1-1', 't1-2'],
  )
})

test('groupScreensByTurn is a pure function of the input order', () => {
  const a = screen({ turnId: 't1', step: 1, createdAt: 100 })
  const b = screen({ turnId: 't2', step: 1, createdAt: 200 })
  const c = screen({ turnId: 't1', step: 2, createdAt: 300 })

  const fromOneOrder = groupScreensByTurn([a, b, c]).map((s) => `${s.turnId}-${s.step}`)
  const fromAnotherOrder = groupScreensByTurn([c, a, b]).map((s) => `${s.turnId}-${s.step}`)

  assert.deepEqual(fromOneOrder, fromAnotherOrder)
})
