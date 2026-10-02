import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * One process per embedded database directory.
 *
 * PGlite opens a data directory from a second process without complaint, and
 * the two then overwrite each other's pages: rows are lost with no error. A
 * second `pnpm dev` (Next quietly moves it to port 3001), `pnpm db:init` while
 * the app runs, or `pnpm start` next to `pnpm dev` all do that. So the
 * directory is claimed with a lock file beside it, `<dir>.lock`, holding the
 * owner's pid: created exclusively, reclaimed when that pid is dead, removed
 * on close and, best effort, when the process exits.
 *
 * Kept outside the directory because PGlite treats the directory as its own
 * Postgres data folder.
 */

export function lockPathFor(dir: string): string {
  return `${dir}.lock`
}

/** Locks this process holds, by lock path. On globalThis so a dev hot reload still sees them. */
const globalForLocks = globalThis as typeof globalThis & { __opendotsDirLocks?: Set<string> }
const held = (globalForLocks.__opendotsDirLocks ??= new Set<string>())

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readHolder(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function releaseAll(): void {
  for (const path of held) {
    if (readHolder(path) === process.pid) rmSync(path, { force: true })
  }
  held.clear()
}

let exitHookInstalled = false

/**
 * Takes the lock file, or returns false when it already exists. A hard link is
 * preferred (the file appears atomically with its content). File systems
 * without hard links (exFAT, some SMB shares) fail link() with something other
 * than EEXIST; there an exclusive create stands in. It has one gap the link
 * does not: between create and write the file is empty, and a starter racing
 * in that instant reads it as stale. Accepted for this fallback only, since
 * two OpenDots processes starting within the same millisecond on such a file
 * system is far rarer than the plain second-process case the lock exists for.
 */
function claim(link: typeof linkSync, draft: string, path: string): boolean {
  try {
    link(draft, path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
  }
  try {
    writeFileSync(path, `${process.pid}\n`, { flag: 'wx' })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

/**
 * Claims `dir` for this process, or throws naming the directory, the pid that
 * holds it, and what to do. Returns the release function (idempotent; it never
 * removes a lock another process has since taken).
 */
export function lockDataDir(dir: string, deps: { link?: typeof linkSync } = {}): () => void {
  const link = deps.link ?? linkSync
  const path = lockPathFor(dir)
  if (held.has(path)) {
    throw new Error(`The embedded database at ${dir} is already open in this process; open it once and share the handle.`)
  }
  mkdirSync(dirname(path), { recursive: true })

  // Written aside and hard-linked into place: the link appears atomically with
  // its content, so no other process can ever read a half-written lock.
  const draft = `${path}.${process.pid}.tmp`
  writeFileSync(draft, `${process.pid}\n`)
  try {
    for (let attempt = 0; ; attempt++) {
      if (claim(link, draft, path)) break
      if (attempt >= 3) throw new Error(`Could not take the lock ${path} after several attempts; another OpenDots process may be starting.`)
      const holder = readHolder(path)
      // Our own pid without our own claim is a pid reused after a restart (a
      // container's pid 1, say): as stale as a dead one.
      if (holder !== null && holder !== process.pid && isAlive(holder)) {
        throw new Error(
          `The embedded database at ${dir} is in use by another OpenDots process (pid ${holder}): ` +
            `stop the other OpenDots process, then try again. If no such process is running, delete ${path}.`,
        )
      }
      // Re-read right before removing, so a lock another starter just took is left alone.
      if (readHolder(path) === holder) rmSync(path, { force: true })
    }
  } finally {
    rmSync(draft, { force: true })
  }

  held.add(path)
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.once('exit', releaseAll)
  }
  return () => {
    if (!held.delete(path)) return
    if (readHolder(path) === process.pid) rmSync(path, { force: true })
  }
}
