import { Pool } from 'pg'

/**
 * Shared Postgres pool.
 *
 * A pool, not a client: every API route handler runs concurrently, and opening
 * a connection per request exhausts Postgres' connection limit under trivial
 * load. The pool is parked on globalThis for the same reason the in-memory
 * store is — hot reload re-evaluates modules, and a fresh pool per reload leaks
 * connections until the database refuses new ones.
 */

const globalForDb = globalThis as typeof globalThis & { __pgPool?: Pool }

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL)
}

export function getPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set — start the stack with docker compose up')
  }

  globalForDb.__pgPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    // Keep well under Postgres' default max_connections (100) so migrations and
    // psql sessions can still get in while the app is running.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })

  return globalForDb.__pgPool
}

/** Cheap liveness probe — useful in the health endpoint once wired. */
export async function pingDatabase(): Promise<boolean> {
  try {
    const result = await getPool().query('SELECT 1 AS ok')
    return result.rows[0]?.ok === 1
  } catch {
    return false
  }
}

/**
 * Formats a JS number[] as a pgvector literal: '[0.1,0.2,...]'.
 *
 * TODO(intern): decide whether to keep doing this or to use a driver-level type
 * parser. Passing the array directly will NOT work — node-postgres serialises a
 * JS array as a Postgres array `{...}`, which the vector type rejects.
 */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`
}
