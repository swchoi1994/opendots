import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
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
 * It also keeps a bot from rewriting its own configuration. `runBot` loads
 * the workspace's project settings (`settingSources: ['project']`), and a
 * `.claude/settings.json` there can run hooks as shell commands and point
 * ANTHROPIC_BASE_URL elsewhere through its `env` block, so a bot that could
 * write it would have a shell and the operator's key. Reads stay allowed; only
 * OpenDots' own server-side code (install_skill) writes under `.claude/`.
 *
 * Bash is deliberately not covered: a shell can reach anything the server
 * user can, which is why `shell` is off by default and documented as host access.
 */

export const GUARDED_TOOLS = ['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep'] as const
export const OUTSIDE_WORKSPACE = 'Bots can only use files inside their own workspace.'
export const CONFIG_FILE = "Bots can't change their own configuration files."

/** The guarded tools that create or change files. */
const WRITING_TOOLS: readonly string[] = ['Write', 'Edit', 'NotebookEdit']

const GLOB_CHARS = /[*?[\]{}]/

/** The file tools expand a leading `~`, so the guard must judge it as the home directory. */
function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
}

const MAX_LINK_HOPS = 40

function lexists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * realpath of the nearest existing ancestor with the missing tail re-attached,
 * so new files resolve too. A dangling symlink counts as existing and is
 * followed by hand: Write creates its target, so the target is what is judged.
 * Throws on a link loop, which the hook turns into a denial.
 */
function realpathNearest(path: string, hops = 0): string {
  if (hops > MAX_LINK_HOPS) throw new Error('too many symbolic links')
  let current = path
  const tail: string[] = []
  while (!lexists(current)) {
    const parent = dirname(current)
    if (parent === current) break
    tail.unshift(basename(current))
    current = parent
  }
  try {
    return join(realpathSync(current), ...tail)
  } catch {
    const target = resolve(dirname(current), readlinkSync(current))
    return realpathNearest(join(target, ...tail), hops + 1)
  }
}

/**
 * Windows ignores trailing dots and spaces in a name and treats `name::$DATA`
 * (an NTFS stream) as the file itself; darwin and win32 file systems are
 * case-insensitive by default. Elsewhere names compare exactly.
 */
function sameNameAs(platform: NodeJS.Platform): (segment: string) => string {
  if (platform === 'win32') return (segment) => fold(segment.replace(/:.*$/, '').replace(/[. ]+$/, ''))
  if (platform === 'darwin') return fold
  return (segment) => segment
}

/**
 * Folds a name the way a case- and normalization-insensitive file system can:
 * compatibility-decompose, drop combining marks, then upper- and lower-case,
 * which maps lookalikes such as U+017F (long s) to "s" and U+212A (Kelvin) to
 * "k". APFS writes `.mcp.jſon` as `.mcp.json`, so plain toLowerCase() is not
 * enough. Over-folding can only deny more names, never fewer.
 */
function fold(segment: string): string {
  return segment.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase().toLowerCase()
}

/**
 * True for what the CLI loads as configuration or instructions: anything under
 * a `.claude` directory (settings, skills, agents, commands, hooks), the
 * project's `.mcp.json`, and CLAUDE.md or CLAUDE.local.md — plus any `.git`
 * directory, whose config can make git run commands. The CLI also picks up
 * CLAUDE.md files and `.claude` directories below its working directory, so
 * those match at any depth; `.mcp.json` is only read at the project root.
 */
export function isConfigPath(root: string, realPath: string, platform: NodeJS.Platform = process.platform): boolean {
  const normal = sameNameAs(platform)
  const segments = relative(root, realPath).split(sep).filter(Boolean).map(normal)
  if (segments.length === 0) return false
  if (segments.includes(normal('.claude'))) return true
  // A `.git` directory makes the folder a repository, and its config can name
  // commands git runs on its own (core.fsmonitor on `git status`).
  if (segments.includes(normal('.git'))) return true
  const name = segments[segments.length - 1]
  if (name === normal('CLAUDE.md') || name === normal('CLAUDE.local.md')) return true
  return segments.length === 1 && name === normal('.mcp.json')
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
  platform: NodeJS.Platform = process.platform,
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
    const real = realpathNearest(candidate)
    if (!isInside(root, real)) return denied
    if (WRITING_TOOLS.includes(tool) && isConfigPath(root, real, platform)) return { ok: false, reason: CONFIG_FILE }
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
