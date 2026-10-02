import { mkdirSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { dataDir } from '../data-dir'

/**
 * A bot's workspace is its "computer": the cwd the Agent SDK runs in, where
 * its files live and where skills.sh packages install (`.claude/skills/`).
 * One directory per channel, named from the channel url after sanitising so a
 * hostile url can never escape the root.
 */

export function workspacesRoot(): string {
  // Runtime path (see data-dir.ts): ignored by file tracing.
  return resolve(/*turbopackIgnore: true*/ process.env.OPENDOTS_WORKSPACES_DIR || join(dataDir(), 'workspaces'))
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
  const dir = resolve(/*turbopackIgnore: true*/ workspacesRoot(), safeName(channelUrl))
  mkdirSync(resolve(dir, '.claude', 'skills'), { recursive: true })
  return dir
}

export function removeWorkspace(channelUrl: string): void {
  try {
    const dir = resolve(/*turbopackIgnore: true*/ workspacesRoot(), safeName(channelUrl))
    const rel = relative(workspacesRoot(), dir)
    // Refuse if relative path is empty, absolute, or escapes the root via '..'.
    if (!rel || isAbsolute(rel) || rel.startsWith('..')) return
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // safeName threw; silently return.
    return
  }
}
