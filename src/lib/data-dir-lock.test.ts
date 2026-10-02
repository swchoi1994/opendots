import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { lockDataDir, lockPathFor } from './data-dir-lock'

/** A pid above every platform's pid_max (Linux 4194304, macOS 99998): never a live process. */
const DEAD_PID = 99_999_999

function dataDirFor(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'opendots-lock-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return join(root, 'db')
}

test('the first opener takes the lock, and releasing it removes the lock file', (t) => {
  const dir = dataDirFor(t)
  const release = lockDataDir(dir)
  assert.equal(readFileSync(lockPathFor(dir), 'utf8').trim(), String(process.pid))
  release()
  assert.equal(existsSync(lockPathFor(dir)), false)
  release() // idempotent
})

test('a directory held by another live process is refused with who holds it and what to do', (t) => {
  const dir = dataDirFor(t)
  // The test runner that spawned this file: a live process that is not us.
  const holder = process.ppid
  writeFileSync(lockPathFor(dir), `${holder}\n`)
  assert.throws(
    () => lockDataDir(dir),
    (error: Error) => {
      assert.match(error.message, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.match(error.message, new RegExp(`pid ${holder}\\b`))
      assert.match(error.message, /stop the other OpenDots process/)
      return true
    },
  )
  assert.equal(readFileSync(lockPathFor(dir), 'utf8').trim(), String(holder), 'the live holder keeps its lock')
})

test('a stale lock left by a dead process is reclaimed', (t) => {
  const dir = dataDirFor(t)
  writeFileSync(lockPathFor(dir), `${DEAD_PID}\n`)
  const release = lockDataDir(dir)
  assert.equal(readFileSync(lockPathFor(dir), 'utf8').trim(), String(process.pid))
  release()
})

test('an unreadable lock file is treated as stale once it is old enough', (t) => {
  const dir = dataDirFor(t)
  writeFileSync(lockPathFor(dir), 'garbage')
  const old = new Date(Date.now() - 60_000)
  utimesSync(lockPathFor(dir), old, old)
  const release = lockDataDir(dir)
  assert.equal(readFileSync(lockPathFor(dir), 'utf8').trim(), String(process.pid))
  release()
})

test('a lock naming our own pid that we do not hold (a reused pid after a restart) is reclaimed', (t) => {
  const dir = dataDirFor(t)
  writeFileSync(lockPathFor(dir), `${process.pid}\n`)
  const release = lockDataDir(dir)
  release()
  assert.equal(existsSync(lockPathFor(dir)), false)
})

test('opening the same directory twice in one process is refused too', (t) => {
  const dir = dataDirFor(t)
  const release = lockDataDir(dir)
  t.after(release)
  assert.throws(() => lockDataDir(dir), /already open in this process/)
})

test('release never removes a lock another process has since taken', (t) => {
  const dir = dataDirFor(t)
  const release = lockDataDir(dir)
  writeFileSync(lockPathFor(dir), `${process.ppid}\n`)
  release()
  assert.equal(readFileSync(lockPathFor(dir), 'utf8').trim(), String(process.ppid))
})

/** A link() that fails the way exFAT or an SMB share does: no hard links at all. Counts its calls. */
function noHardLinks(): { link: () => never; calls: () => number } {
  let calls = 0
  return {
    link: () => {
      calls += 1
      throw Object.assign(new Error('operation not permitted, link'), { code: 'EPERM' })
    },
    calls: () => calls,
  }
}

test('on a file system without hard links the lock still works, by exclusive create', (t) => {
  const dir = dataDirFor(t)
  const fs = noHardLinks()
  const release = lockDataDir(dir, { link: fs.link })
  assert.ok(fs.calls() >= 1, 'the injected link() was used')
  assert.equal(readFileSync(lockPathFor(dir), 'utf8').trim(), String(process.pid))
  release()
  assert.equal(existsSync(lockPathFor(dir)), false)
})

test('without hard links a live holder is still refused, and a stale one reclaimed', (t) => {
  const live = dataDirFor(t)
  writeFileSync(lockPathFor(live), `${process.ppid}\n`)
  const liveFs = noHardLinks()
  assert.throws(() => lockDataDir(live, { link: liveFs.link }), /in use by another OpenDots process/)
  assert.ok(liveFs.calls() >= 1)

  const stale = dataDirFor(t)
  writeFileSync(lockPathFor(stale), `${DEAD_PID}\n`)
  const staleFs = noHardLinks()
  const release = lockDataDir(stale, { link: staleFs.link })
  assert.ok(staleFs.calls() >= 1)
  assert.equal(readFileSync(lockPathFor(stale), 'utf8').trim(), String(process.pid))
  release()
})

test('a brand-new empty or unreadable lock is another starter mid-write, not a stale one', (t) => {
  // Without hard links the lock is created empty and then written; reclaiming it
  // in that instant would let two processes open the same database.
  const empty = dataDirFor(t)
  writeFileSync(lockPathFor(empty), '')
  assert.throws(() => lockDataDir(empty), /being opened by another OpenDots process/)
  assert.equal(readFileSync(lockPathFor(empty), 'utf8'), '', 'the other starter keeps its lock')

  const partial = dataDirFor(t)
  writeFileSync(lockPathFor(partial), '12')
  writeFileSync(lockPathFor(partial), 'x')
  assert.throws(() => lockDataDir(partial), /being opened by another OpenDots process/)
})
