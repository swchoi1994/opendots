import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk'

/**
 * Keeps a bot's file tools inside its own workspace.
 *
 * This has to be a PreToolUse hook: tools named in `allowedTools` are
 * approved before `canUseTool` is ever consulted, so a path check there would
 * silently never run for a granted tool. Hooks run first, on every call.
 *
 * Bash is deliberately not covered: a shell can reach anything the server
 * user can, which is why `shell` is off by default and documented as host access.
 */

export const GUARDED_TOOLS = ['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep'] as const
export const OUTSIDE_WORKSPACE = 'Bots can only use files inside their own workspace.'

const GLOB_CHARS = /[*?[\]{}]/

/** The file tools expand a leading `~`, so the guard must judge it as the home directory. */
function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
}

/** realpath of the nearest existing ancestor with the missing tail re-attached, so new files resolve too. */
function realpathNearest(path: string): string {
  let current = path
  const tail: string[] = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    tail.unshift(basename(current))
    current = parent
  }
  return join(realpathSync(current), ...tail)
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** The fixed directory a glob starts from, and whether it climbs with ".." after a wildcard. */
function splitGlob(pattern: string): { prefix: string; climbsAfterWildcard: boolean } {
  const segments = pattern.split('/')
  const firstWild = segments.findIndex((segment) => GLOB_CHARS.test(segment))
  const fixed = firstWild === -1 ? segments : segments.slice(0, firstWild)
  const rest = firstWild === -1 ? [] : segments.slice(firstWild)
  let prefix = fixed.join('/')
  if (pattern.startsWith('/') && prefix === '') prefix = '/'
  return { prefix, climbsAfterWildcard: rest.includes('..') }
}

export function checkWorkspacePath(
  tool: string,
  input: unknown,
  workspaceDir: string,
): { ok: true } | { ok: false; reason: string } {
  if (!(GUARDED_TOOLS as readonly string[]).includes(tool)) return { ok: true }
  const denied = { ok: false as const, reason: OUTSIDE_WORKSPACE }
  const record = (input ?? {}) as Record<string, unknown>
  const root = realpathSync(workspaceDir)
  const at = (value: string, base: string = root) => resolve(base, expandHome(value))

  const candidates: string[] = []
  for (const key of ['file_path', 'notebook_path', 'path'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) candidates.push(at(value))
  }
  if (tool === 'Glob' && typeof record.pattern === 'string') {
    const { prefix, climbsAfterWildcard } = splitGlob(record.pattern)
    if (climbsAfterWildcard) return denied
    const base = typeof record.path === 'string' && record.path.length > 0 ? at(record.path) : root
    candidates.push(at(prefix, base))
  }

  for (const candidate of candidates) {
    if (!isInside(root, realpathNearest(candidate))) return denied
  }
  return { ok: true }
}

/** The PreToolUse hook `runBot` installs on every run. Any error denies: a guard that throws must not open the door. */
export function workspaceGuardHook(workspaceDir: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    let verdict: ReturnType<typeof checkWorkspacePath>
    try {
      verdict = checkWorkspacePath(input.tool_name, input.tool_input, workspaceDir)
    } catch {
      verdict = { ok: false, reason: OUTSIDE_WORKSPACE }
    }
    if (verdict.ok) return {}
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: verdict.reason,
      },
    }
  }
}
