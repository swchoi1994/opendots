import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Minimal .env loader for CLI scripts.
 *
 * `next dev` loads .env then .env.local automatically, but a plain `tsx` script
 * does not — so DATA_STORE, RAG_VECTOR_STORE, DATABASE_URL and the rest of the
 * brain and store settings would all be invisible to `pnpm eval` / `pnpm db:init`
 * without this. Loads .env first, then .env.local (so .env.local overrides),
 * matching Next's order.
 */
export function loadEnv(cwd: string = process.cwd()): void {
  for (const file of ['.env', '.env.local']) {
    let text: string
    try {
      text = readFileSync(join(cwd, file), 'utf8')
    } catch {
      continue // file is optional
    }
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
      if (!match) continue // skip blanks and # comments
      let value = match[2]!.trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      process.env[match[1]!] = value
    }
  }
}
