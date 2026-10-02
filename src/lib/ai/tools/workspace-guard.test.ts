import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { CONFIG_FILE, OUTSIDE_WORKSPACE, checkWorkspacePath, workspaceGuardHook } from './workspace-guard'

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

const configDenied = { ok: false, reason: CONFIG_FILE }

test('file tools cannot create or change what the CLI loads as configuration or instructions', (t) => {
  const ws = workspace(t)
  mkdirSync(join(ws, '.claude', 'skills', 'pdf'), { recursive: true })
  writeFileSync(join(ws, '.claude', 'settings.json'), '{}')
  for (const tool of ['Write', 'Edit'] as const) {
    assert.deepEqual(checkWorkspacePath(tool, { file_path: '.claude/settings.json' }, ws), configDenied, `${tool} .claude/settings.json`)
    assert.deepEqual(checkWorkspacePath(tool, { file_path: join(ws, '.claude', 'settings.json') }, ws), configDenied, `${tool} absolute settings`)
    assert.deepEqual(checkWorkspacePath(tool, { file_path: '.claude/settings.local.json' }, ws), configDenied, `${tool} settings.local.json`)
    assert.deepEqual(checkWorkspacePath(tool, { file_path: '.mcp.json' }, ws), configDenied, `${tool} .mcp.json`)
    assert.deepEqual(checkWorkspacePath(tool, { file_path: 'CLAUDE.md' }, ws), configDenied, `${tool} CLAUDE.md`)
    assert.deepEqual(checkWorkspacePath(tool, { file_path: 'CLAUDE.local.md' }, ws), configDenied, `${tool} CLAUDE.local.md`)
  }
  for (const path of ['.claude/skills/pdf/SKILL.md', '.claude/agents/a.md', '.claude/commands/c.md', '.claude/hooks/h.sh', '.claude']) {
    assert.deepEqual(checkWorkspacePath('Write', { file_path: path }, ws), configDenied, path)
  }
  assert.deepEqual(checkWorkspacePath('NotebookEdit', { notebook_path: '.claude/n.ipynb' }, ws), configDenied)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'notes/../.claude/settings.json' }, ws), configDenied, 'a detour through .. still lands in .claude')
  // The CLI also loads CLAUDE.md and .claude/ found below the working directory.
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'notes/CLAUDE.md' }, ws), configDenied)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'notes/.claude/settings.json' }, ws), configDenied)
})

test('ordinary files with similar names stay writable', (t) => {
  const ws = workspace(t)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'claude-notes.md' }, ws), allowed)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'notes/.claude-backup.md' }, ws), allowed)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'notes/mcp.json' }, ws), allowed)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'notes/README.md' }, ws), allowed)
})

test('on darwin and win32 a case variant of a configuration path is the same path', (t) => {
  const ws = workspace(t)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: '.Claude/settings.json' }, ws, 'darwin'), configDenied)
  assert.deepEqual(checkWorkspacePath('Edit', { file_path: '.MCP.json' }, ws, 'darwin'), configDenied)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'claude.MD' }, ws, 'win32'), configDenied)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'CLAUDE.md. ' }, ws, 'win32'), configDenied, 'Windows drops trailing dots and spaces')
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'CLAUDE.md::$DATA' }, ws, 'win32'), configDenied, 'an NTFS stream name is the same file')
  // Elsewhere the file system is case-sensitive and `.Claude` is a different directory the CLI never reads.
  assert.deepEqual(checkWorkspacePath('Write', { file_path: '.Claude/settings.json' }, ws, 'linux'), allowed)
})

test('a symlink cannot be used to reach the configuration paths', (t) => {
  const ws = workspace(t)
  mkdirSync(join(ws, '.claude'), { recursive: true })
  symlinkSync(join(ws, '.claude'), join(ws, 'cfg'))
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'cfg/settings.json' }, ws), configDenied)
  assert.deepEqual(checkWorkspacePath('Edit', { file_path: join(ws, 'cfg', 'settings.json') }, ws), configDenied)
  // A dangling link: the target does not exist yet, but Write would create it through the link.
  symlinkSync(join(ws, '.claude', 'settings.json'), join(ws, 'harmless.json'))
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'harmless.json' }, ws), configDenied)
  symlinkSync(join(ws, '.mcp.json'), join(ws, 'servers.json'))
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'servers.json' }, ws), configDenied)
})

test('a dangling symlink cannot be used to write outside the workspace', (t) => {
  const ws = workspace(t)
  symlinkSync(join(ws, '..', 'planted.txt'), join(ws, 'out.txt'))
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'out.txt' }, ws), denied)
})

test('reading and searching the configuration stays allowed', (t) => {
  const ws = workspace(t)
  mkdirSync(join(ws, '.claude'), { recursive: true })
  writeFileSync(join(ws, '.claude', 'settings.json'), '{}')
  assert.deepEqual(checkWorkspacePath('Read', { file_path: '.claude/settings.json' }, ws), allowed)
  assert.deepEqual(checkWorkspacePath('Read', { file_path: 'CLAUDE.md' }, ws), allowed)
  assert.deepEqual(checkWorkspacePath('Glob', { pattern: '.claude/**' }, ws), allowed)
  assert.deepEqual(checkWorkspacePath('Grep', { pattern: 'hooks', path: '.claude' }, ws), allowed)
})

test('the hook names the configuration rule when it denies', async (t) => {
  const ws = workspace(t)
  const hook = workspaceGuardHook(ws)
  const signal = new AbortController().signal
  const base = { session_id: 's', transcript_path: '/t', cwd: ws, hook_event_name: 'PreToolUse' as const, tool_use_id: 'u1' }
  assert.deepEqual(
    await hook({ ...base, tool_name: 'Write', tool_input: { file_path: '.claude/settings.json', content: '{}' } }, 'u1', { signal }),
    { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: CONFIG_FILE } },
  )
  assert.equal(CONFIG_FILE, "Bots can't change their own configuration files.")
})

test('on darwin and win32 Unicode lookalikes of a configuration path are the same path', (t) => {
  const ws = workspace(t)
  // APFS folds U+017F (long s) to "s", so `.mcp.jſon` is written as `.mcp.json`.
  assert.deepEqual(checkWorkspacePath('Write', { file_path: '.mcp.jſon' }, ws, 'darwin'), configDenied)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: '.mcp.jſon' }, ws, 'win32'), configDenied)
  // U+212A (Kelvin sign) folds to "k"; a combining mark rides on a plain letter.
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'CLAUDE.md'.replace('A', 'Á') }, ws, 'darwin'), configDenied)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: '.claude/sKills/x/SKILL.md' }, ws, 'darwin'), configDenied)
  // A case-sensitive file system keeps them distinct, so nothing extra is denied there.
  assert.deepEqual(checkWorkspacePath('Write', { file_path: '.mcp.jſon' }, ws, 'linux'), allowed)
})

test('a bot cannot turn its workspace into a git repository', (t) => {
  const ws = workspace(t)
  // A bot-written .git/config can set core.fsmonitor, a command git runs on `git status`.
  assert.deepEqual(checkWorkspacePath('Write', { file_path: '.git/config' }, ws), configDenied)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: '.git/HEAD' }, ws), configDenied)
  assert.deepEqual(checkWorkspacePath('Edit', { file_path: 'notes/.git/config' }, ws), configDenied)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: '.GIT/config' }, ws, 'darwin'), configDenied)
  assert.deepEqual(checkWorkspacePath('Read', { file_path: '.git/config' }, ws), allowed)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'notes/.gitignore' }, ws), allowed)
})

test('names that HFS+ or exFAT store as a protected name are denied on darwin', (t) => {
  const ws = workspace(t)
  // HFS+ ignores zero-width and bidi format characters inside names.
  assert.deepEqual(checkWorkspacePath('Write', { file_path: '.cl‌aude/settings.json' }, ws, 'darwin'), configDenied)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: '.mcp.j﻿son' }, ws, 'darwin'), configDenied)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'CLAUDE‍.md' }, ws, 'darwin'), configDenied)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: '.g‪it/config' }, ws, 'darwin'), configDenied)
  // On exFAT and SMB, macOS stores U+F029 as "." (the Services for Macintosh mapping).
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'claude/settings.json' }, ws, 'darwin'), configDenied)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'CLAUDEmd' }, ws, 'darwin'), configDenied)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'git/config' }, ws, 'win32'), configDenied)
})

test('a bot cannot make any folder of its workspace a bare git repository', (t) => {
  const ws = workspace(t)
  // git treats a folder holding HEAD, config, objects/ and refs/ as a repository.
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'HEAD' }, ws), configDenied)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'notes/HEAD' }, ws), configDenied)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'head' }, ws, 'darwin'), configDenied)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'HEADER.md' }, ws), allowed)
  assert.deepEqual(checkWorkspacePath('Read', { file_path: 'HEAD' }, ws), allowed)
})
