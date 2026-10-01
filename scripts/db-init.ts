import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool } from 'pg'
import { loadEnv } from './load-env'

/**
 * One-shot schema initialiser: `pnpm db:init`.
 *
 * docker compose would have run every db/*.sql file automatically the first
 * time the Postgres volume was created (the docker-entrypoint-initdb.d
 * mount). Running without Docker, nothing does that for us, so this script
 * applies the same files, in name order, against whatever DATABASE_URL
 * points at.
 *
 * It reuses the `pg` driver already in the project and loads .env/.env.local the
 * exact way Next.js does, so the connection string resolves identically here and
 * in the running app. Each file is idempotent (CREATE ... IF NOT EXISTS), so
 * re-running this is safe.
 */
async function main() {
  loadEnv(process.cwd())

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('DATABASE_URL is not set — add it to .env.local first.')
    process.exit(1)
  }

  const dir = join(process.cwd(), 'db')
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()

  const pool = new Pool({ connectionString })
  try {
    for (const file of files) {
      await pool.query(readFileSync(join(dir, file), 'utf8'))
      console.log(`Applied db/${file}`)
    }

    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
       ORDER BY table_name`,
    )
    console.log('Public tables now present:')
    for (const row of rows) console.log('  -', row.table_name)

    const { rows: ext } = await pool.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname = 'vector'`,
    )
    console.log(ext.length ? 'pgvector extension: enabled' : 'pgvector extension: MISSING')
  } finally {
    await pool.end()
  }
}

void main()
