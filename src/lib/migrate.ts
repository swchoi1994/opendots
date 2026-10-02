import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from './db'

/** db/*.sql, resolved from the working directory: the app root in dev and tests, /app in the container. */
export const MIGRATIONS_DIR = join(process.cwd(), 'db')

/**
 * Applies every migration not yet recorded in `schema_migrations`, in name
 * order, inside one transaction: a failing file leaves the database exactly
 * as it was. The advisory lock serialises two app instances starting against
 * one Postgres server. Returns the files this call applied.
 */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = readdirSync(dir).filter((file) => file.endsWith('.sql')).sort()
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('opendots_migrate'))")
    await tx.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
    const { rows } = await tx.query<{ name: string }>('SELECT name FROM schema_migrations')
    const done = new Set(rows.map((row) => row.name))
    const applied: string[] = []
    for (const file of files) {
      if (done.has(file)) continue
      await tx.exec(readFileSync(join(dir, file), 'utf8'))
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
      applied.push(file)
    }
    return applied
  })
}
