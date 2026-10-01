import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('an unreadable lock file is treated as stale', (t) => {
  const dir = dataDirFor(t)
  writeFileSync(lockPathFor(dir), 'garbage')
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
