import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite, types, type Transaction } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { Pool, type QueryResult } from 'pg'
import { dataDir } from './data-dir'
import { lockDataDir } from './data-dir-lock'
import { migrate } from './migrate'

/**
 * The storage seam under PostgresChatRepository. Both implementations speak
 * the same SQL: PGlite (Postgres compiled to WASM, embedded, the default) and
 * a Postgres server through a `pg` pool when DATA_STORE=postgres.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>
  /** Runs a script of several statements with no parameters (migrations). */
  exec(sql: string): Promise<void>
  /** Runs `fn` inside one transaction; a throw rolls all of it back. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>
}

export type StoreKind = 'pglite' | 'postgres' | 'memory'

export function storeKind(env: Partial<NodeJS.ProcessEnv> = process.env): StoreKind {
  return env.DATA_STORE === 'postgres' || env.DATA_STORE === 'memory' ? env.DATA_STORE : 'pglite'
}

const noNesting = async (): Promise<never> => {
  throw new Error('Nested transactions are not supported')
}

// ---- PGlite -----------------------------------------------------------------

/** int8 stays a string, as node-postgres returns it, so both backends hand the repository identical rows. */
const PARSERS = { [types.INT8]: (value: string) => value }

/**
 * An embedded database: file-backed under `dir`, or in memory when `dir` is
 * omitted (tests). Opening a directory does not lock it: go through `openDb`,
 * which does (data-dir-lock.ts), so no second process can open it alongside.
 */
export async function openPglite(dir?: string): Promise<PGlite> {
  if (dir) mkdirSync(dir, { recursive: true })
  return PGlite.create({ ...(dir ? { dataDir: dir } : {}), extensions: { vector }, parsers: PARSERS })
}

function pgliteHandle(handle: PGlite | Transaction, transaction: Db['transaction']): Db {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const result = await handle.query<T>(sql, params)
      return { rows: result.rows, rowCount: result.affectedRows || result.rows.length }
    },
    async exec(sql: string) {
      await handle.exec(sql)
    },
    transaction,
  }
}

export function pgliteDb(pg: PGlite): Db {
  return pgliteHandle(pg, (fn) => pg.transaction((tx) => fn(pgliteHandle(tx, noNesting))))
}

// ---- Postgres server ----------------------------------------------------------

type Queryable = { query(sql: string, params?: unknown[]): Promise<QueryResult> }

function pgHandle(client: Queryable, transaction: Db['transaction']): Db {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const result = await client.query(sql, params)
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 }
    },
    async exec(sql: string) {
      await client.query(sql)
    },
    transaction,
  }
}

export function pgDb(pool: Pool): Db {
  return pgHandle(pool, async (fn) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(pgHandle(client, noNesting))
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  })
}

/*
 * Parked on globalThis: hot reload re-evaluates modules, a fresh pool per
 * reload leaks connections, and a second PGlite on the same data directory
 * would corrupt it.
 */
const globalForDb = globalThis as typeof globalThis & { __pgPool?: Pool; __opendotsDb?: Db }

export function getPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set: DATA_STORE=postgres needs a Postgres connection string')
  }
  globalForDb.__pgPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    // Well under Postgres' default max_connections (100), so migrations and
    // psql sessions still get in while the app runs.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })
  return globalForDb.__pgPool
}

/** Opens a backend without migrating it. `close` is for scripts; the app keeps its database for the process lifetime. */
export async function openDb(
  kind: 'pglite' | 'postgres' = storeKind() === 'postgres' ? 'postgres' : 'pglite',
): Promise<{ db: Db; close: () => Promise<void> }> {
  if (kind === 'postgres') {
    const pool = getPool()
    return { db: pgDb(pool), close: () => pool.end() }
  }
  const dir = join(dataDir(), 'db')
  // Throws, naming the directory and the holder's pid, while another process has it open.
  const release = lockDataDir(dir)
  let pg: PGlite
  try {
    pg = await openPglite(dir)
  } catch (error) {
    release()
    throw error
  }
  return {
    db: pgliteDb(pg),
    close: async () => {
      try {
        await pg.close()
      } finally {
        release()
      }
    },
  }
}

/**
 * Defers opening (async) to the first query, so callers get a Db
 * synchronously, then defers `prepare` (e.g. migrate) the same way.
 *
 * `open` and `prepare` are memoized SEPARATELY and must stay that way: for
 * the file-backed PGlite path, `open()` creates a live handle on disk, and a
 * second `open()` on the same data directory while the first is still live
 * does not error — it silently diverges from it (two independent handles on
 * one directory, each unaware of the other's writes). If a `prepare` failure
 * (a bad migration) reset the SAME retry slot as `open`, every retry after a
 * broken migration would call `open()` again and leak one more orphaned,
 * diverging PGlite instance — the migration fails identically every time, so
 * nothing would ever stop. Resetting only `prepared` on a `prepare` failure
 * makes the retry reuse the one already-open handle; `opened` is reset only
 * when `open()` itself throws.
 */
export function lazyDb(open: () => Promise<Db>, prepare: (db: Db) => Promise<unknown>): Db {
  let opened: Promise<Db> | null = null
  const getOpened = () =>
    (opened ??= open().catch((error: unknown) => {
      opened = null // a failed open is retried by the next caller, not cached
      throw error
    }))

  let prepared: Promise<Db> | null = null
  const get = () =>
    (prepared ??= getOpened()
      .then(async (db) => {
        await prepare(db)
        return db
      })
      .catch((error: unknown) => {
        prepared = null // a failed prepare retries against the SAME opened handle, not a new one
        throw error
      }))

  return {
    async query<T>(sql: string, params?: unknown[]) {
      return (await get()).query<T>(sql, params)
    },
    async exec(sql: string) {
      return (await get()).exec(sql)
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      return (await get()).transaction(fn)
    },
  }
}

/** The process-wide database: opened and migrated on first use, so nobody has to run db:init first. */
export function getDb(): Db {
  globalForDb.__opendotsDb ??= lazyDb(async () => (await openDb()).db, migrate)
  return globalForDb.__opendotsDb
}
