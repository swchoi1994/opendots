import { mkdirSync, rmSync } from 'node:fs'
import { relative, resolve, isAbsolute } from 'node:path'

/**
 * A bot's workspace is its "computer": the cwd the Agent SDK runs in, where
 * its files live and where skills.sh packages install (`.claude/skills/`).
 * One directory per channel, named from the channel url after sanitising so a
 * hostile url can never escape the root.
 */

const DEFAULT_ROOT = './.opendots/workspaces'

export function workspacesRoot(): string {
  return resolve(process.env.OPENDOTS_WORKSPACES_DIR || DEFAULT_ROOT)
}

function safeName(channelUrl: string): string {
  // Collapse runs of anything outside [A-Za-z0-9_-] to '_', and neutralise '..'.
  const name = channelUrl.replace(/\.\./g, '_._').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/\.\./g, '_')
  // Refuse names that are empty or consist only of safe separators.
  if (!name || /^[._-]*$/.test(name)) {
    throw new Error('channelUrl must contain at least one alphanumeric character')
  }
  return name
}

export function workspaceFor(channelUrl: string): string {
  const dir = resolve(workspacesRoot(), safeName(channelUrl))
  mkdirSync(resolve(dir, '.claude', 'skills'), { recursive: true })
  return dir
}

export function removeWorkspace(channelUrl: string): void {
  try {
    const dir = resolve(workspacesRoot(), safeName(channelUrl))
    const rel = relative(workspacesRoot(), dir)
    // Refuse if relative path is empty, absolute, or escapes the root via '..'.
    if (!rel || isAbsolute(rel) || rel.startsWith('..')) return
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // safeName threw; silently return.
    return
  }
}
