import { openDb, storeKind } from '../src/lib/db'
import { migrate } from '../src/lib/migrate'
import { loadEnv } from './load-env'

/**
 * `pnpm db:init`: applies pending db/*.sql migrations now. The app already
 * does this on first use; this is for readying a Postgres server before the
 * app starts, or for seeing what a migration run does.
 *
 * Stop OpenDots first when using the embedded database: two processes must
 * never open the same PGlite data directory, and openDb refuses (naming the
 * pid that holds it) while the app has it open.
 */
async function main() {
  loadEnv(process.cwd())
  const kind = storeKind()
  if (kind === 'memory') {
    console.error('DATA_STORE=memory keeps nothing on disk, so there is nothing to migrate.')
    process.exit(1)
  }
  const { db, close } = await openDb(kind)
  try {
    const applied = await migrate(db)
    console.log(applied.length > 0 ? `Applied: ${applied.join(', ')}` : 'Already up to date.')
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    )
    console.log(`Tables (${kind}): ${rows.map((row) => row.table_name).join(', ')}`)
  } finally {
    await close()
  }
}

main().catch((error: unknown) => {
  // A plain message, not a stack trace: the usual cause is "the app is running".
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
