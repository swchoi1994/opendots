import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { removeWorkspace, workspaceFor, workspacesRoot } from './workspace'

test('workspaceFor creates a sanitised directory with .claude/skills and is idempotent', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'opendots-root-'))
  process.env.OPENDOTS_WORKSPACES_DIR = root
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    delete process.env.OPENDOTS_WORKSPACES_DIR
  })

  assert.equal(workspacesRoot(), root)
  const dir = workspaceFor('bot_chief-of-staff/../x')
  // '..' becomes '_._' first, then the '/' runs become '_': no traversal survives.
  assert.equal(dir, join(root, 'bot_chief-of-staff__.__x'))
  assert.ok(existsSync(join(dir, '.claude', 'skills')))
  assert.equal(workspaceFor('bot_chief-of-staff/../x'), dir)

  removeWorkspace('bot_chief-of-staff/../x')
  assert.equal(existsSync(dir), false)
  removeWorkspace('never-existed') // must not throw

  // Empty string must throw
  assert.throws(() => workspaceFor(''), /must contain at least one alphanumeric character/)

  // Names that sanitize to nothing (only dots, underscores, hyphens) must throw for workspaceFor
  assert.throws(() => workspaceFor('...'), /must contain at least one alphanumeric character/)
  // removeWorkspace silently fails for invalid names (does not throw)
  removeWorkspace('...')

  // Removing one workspace must not affect sibling workspaces
  const botA = workspaceFor('bot_a')
  const botB = workspaceFor('bot_b')
  assert.ok(existsSync(botA))
  assert.ok(existsSync(botB))
  removeWorkspace('bot_a')
  assert.equal(existsSync(botA), false)
  assert.ok(existsSync(botB))
})
