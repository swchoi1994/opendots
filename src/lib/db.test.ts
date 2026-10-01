import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lazyDb, type Db } from './db'

/** A minimal Db double: no network, nothing written to disk. */
function fakeDb(): Db {
  return {
    async query<T>() {
      return { rows: [] as T[], rowCount: 0 }
    },
    async exec() {},
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      return fn(fakeDb())
    },
  }
}

test('lazyDb: a failed prepare retries against the same opened handle, not a new one', async () => {
  let openCalls = 0
  let prepareCalls = 0
  const db = lazyDb(
    async () => {
      openCalls++
      return fakeDb()
    },
    async () => {
      prepareCalls++
      if (prepareCalls === 1) throw new Error('migration boom')
    },
  )

  // First call: open succeeds, prepare (migrate) fails.
  await assert.rejects(db.query('SELECT 1'), /migration boom/)
  assert.equal(openCalls, 1)
  assert.equal(prepareCalls, 1)

  // Second call: must retry prepare against the SAME handle, not re-open.
  const result = await db.query('SELECT 1')
  assert.deepEqual(result, { rows: [], rowCount: 0 })
  assert.equal(openCalls, 1, 'a failed prepare must not re-open the handle')
  assert.equal(prepareCalls, 2, 'the retry must re-run prepare against the already-open handle')
})

test('lazyDb: a failed open is retried by the next call', async () => {
  let openCalls = 0
  const db = lazyDb(
    async () => {
      openCalls++
      if (openCalls === 1) throw new Error('open boom')
      return fakeDb()
    },
    async () => {},
  )

  await assert.rejects(db.query('SELECT 1'), /open boom/)
  await db.query('SELECT 1')
  assert.equal(openCalls, 2, 'a failed open must be retried, not cached forever')
})

test('lazyDb: concurrent first calls share a single open', async () => {
  let openCalls = 0
  const db = lazyDb(
    async () => {
      openCalls++
      // Hold the open pending across both query() calls below, so the test
      // actually proves they share one in-flight open rather than just
      // happening to run fast enough to look that way.
      await new Promise((resolve) => setTimeout(resolve, 10))
      return fakeDb()
    },
    async () => {},
  )

  await Promise.all([db.query('SELECT 1'), db.query('SELECT 1')])
  assert.equal(openCalls, 1, 'two calls issued before the open resolves must share one open() call')
})
