import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { OUTSIDE_WORKSPACE, checkWorkspacePath, workspaceGuardHook } from './workspace-guard'

/** A real workspace under the OS temp dir. On macOS that path itself runs through the /var -> /private/var symlink. */
function workspace(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'opendots-guard-'))
  const ws = join(root, 'ws')
  mkdirSync(join(ws, 'notes'), { recursive: true })
  writeFileSync(join(ws, 'notes', 'a.md'), 'hello')
  writeFileSync(join(root, 'secret.txt'), 'outside')
  symlinkSync(root, join(ws, 'escape'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return ws
}

const allowed = { ok: true }
const denied = { ok: false, reason: OUTSIDE_WORKSPACE }

test('paths inside the workspace are allowed, including files that do not exist yet', (t) => {
  const ws = workspace(t)
  assert.deepEqual(checkWorkspacePath('Read', { file_path: 'notes/a.md' }, ws), allowed)
  assert.deepEqual(checkWorkspacePath('Read', { file_path: join(ws, 'notes', 'a.md') }, ws), allowed)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: join(ws, 'new', 'deep', 'b.md') }, ws), allowed)
  assert.deepEqual(checkWorkspacePath('Edit', { file_path: 'notes/a.md' }, ws), allowed)
  assert.deepEqual(checkWorkspacePath('Grep', { pattern: 'TODO' }, ws), allowed)
  assert.deepEqual(checkWorkspacePath('Glob', { pattern: '**/*.md' }, ws), allowed)
  assert.deepEqual(checkWorkspacePath('Glob', { pattern: 'notes/*.md', path: 'notes' }, ws), allowed)
})

test('paths that leave the workspace are denied', (t) => {
  const ws = workspace(t)
  assert.deepEqual(checkWorkspacePath('Read', { file_path: '../secret.txt' }, ws), denied)
  assert.deepEqual(checkWorkspacePath('Read', { file_path: '/etc/hosts' }, ws), denied)
  assert.deepEqual(checkWorkspacePath('Read', { file_path: '~/.ssh/id_rsa' }, ws), denied)
  assert.deepEqual(checkWorkspacePath('Read', { file_path: join(homedir(), '.ssh', 'id_rsa') }, ws), denied)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: '/tmp/x' }, ws), denied)
  assert.deepEqual(checkWorkspacePath('NotebookEdit', { notebook_path: '/tmp/n.ipynb' }, ws), denied)
  assert.deepEqual(checkWorkspacePath('Grep', { pattern: 'key', path: '/' }, ws), denied)
})

test('a symlink inside the workspace cannot be used to step out of it', (t) => {
  const ws = workspace(t)
  assert.deepEqual(checkWorkspacePath('Read', { file_path: 'escape/secret.txt' }, ws), denied)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'escape/new.txt' }, ws), denied)
})

test('glob patterns are judged by where they can reach', (t) => {
  const ws = workspace(t)
  assert.deepEqual(checkWorkspacePath('Glob', { pattern: '/etc/**' }, ws), denied)
  assert.deepEqual(checkWorkspacePath('Glob', { pattern: '/**' }, ws), denied)
  assert.deepEqual(checkWorkspacePath('Glob', { pattern: '../*' }, ws), denied)
  assert.deepEqual(checkWorkspacePath('Glob', { pattern: 'notes/**/../../../*' }, ws), denied, '".." after a wildcard is refused outright')
  assert.deepEqual(checkWorkspacePath('Glob', { pattern: '~/**' }, ws), denied)
})

test('tools the guard does not cover pass through', (t) => {
  const ws = workspace(t)
  assert.deepEqual(checkWorkspacePath('Bash', { command: 'cat /etc/hosts' }, ws), allowed)
  assert.deepEqual(checkWorkspacePath('mcp__opendots__search_knowledge', { query: '/etc' }, ws), allowed)
})

test('the hook denies with the reason, allows silently, and fails closed', async (t) => {
  const ws = workspace(t)
  const hook = workspaceGuardHook(ws)
  const signal = new AbortController().signal
  const base = { session_id: 's', transcript_path: '/t', cwd: ws, hook_event_name: 'PreToolUse' as const, tool_use_id: 'u1' }

  assert.deepEqual(await hook({ ...base, tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } }, 'u1', { signal }), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: OUTSIDE_WORKSPACE },
  })
  assert.deepEqual(await hook({ ...base, tool_name: 'Read', tool_input: { file_path: 'notes/a.md' } }, 'u1', { signal }), {})

  const gone = workspaceGuardHook(join(ws, 'does-not-exist'))
  const verdict = await gone({ ...base, tool_name: 'Read', tool_input: { file_path: 'a.md' } }, 'u1', { signal })
  assert.equal((verdict as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, 'deny')
})
