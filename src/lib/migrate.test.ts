import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openPglite, pgliteDb } from './db'
import { migrate } from './migrate'

test('migrate applies every db/*.sql once and records each file', async () => {
  const db = pgliteDb(await openPglite())
  const first = await migrate(db)
  assert.deepEqual(first, ['001_init.sql', '002_bots.sql', '003_screens.sql', '004_session_provider.sql'])
  assert.deepEqual(await migrate(db), [], 'a second run applies nothing')

  const { rows } = await db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')
  assert.deepEqual(rows.map((row) => row.name), first)
  const tables = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  )
  for (const table of ['channels', 'messages', 'bot_sessions', 'screens', 'skills']) {
    assert.ok(tables.rows.some((row) => row.table_name === table), `${table} exists`)
  }
})

test('a failing migration rolls everything back and records nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-migrate-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, '001_ok.sql'), 'CREATE TABLE ok_t (id INT);')
  writeFileSync(join(dir, '002_bad.sql'), 'CREATE TABLE bad_t (id INT);\nSELECT * FROM no_such_table;')

  const db = pgliteDb(await openPglite())
  await assert.rejects(migrate(db, dir), /no_such_table/)
  const { rows } = await db.query<{ ok: string | null; log: string | null }>(
    `SELECT to_regclass('public.ok_t')::text AS ok, to_regclass('public.schema_migrations')::text AS log`,
  )
  assert.deepEqual(rows[0], { ok: null, log: null })
})

test('PGlite returns bigint columns as strings, exactly like node-postgres', async () => {
  const db = pgliteDb(await openPglite())
  const { rows } = await db.query<{ n: unknown }>('SELECT 9007199254740993::bigint AS n')
  assert.equal(rows[0]?.n, '9007199254740993')
})

test('rowCount counts affected rows for writes and returned rows for reads', async () => {
  const db = pgliteDb(await openPglite())
  await db.exec('CREATE TABLE t (id INT); INSERT INTO t VALUES (1), (2), (3);')
  assert.equal((await db.query('DELETE FROM t WHERE id > 1')).rowCount, 2)
  assert.equal((await db.query('DELETE FROM t WHERE id > 100')).rowCount, 0)
  assert.equal((await db.query('SELECT * FROM t')).rowCount, 1)
})
