import { createHash } from 'node:crypto'
import { HOST_TOOLS, type AssistantConfig } from '../domain/assistant'
import type { RosterEntry } from '../domain/roster'
import { rosterAssistant } from '../domain/seed'
import { LOCAL_SCOPE, type Scope } from './chat-repository'

/**
 * A starter bot's channel url. Channel urls are unique across the whole
 * instance (they name workspace folders and share links), so every workspace
 * but `local` gets its own suffix; `local` keeps A's urls (`bot_<slug>`).
 */
export function seedChannelUrl(slug: string, workspaceId: string): string {
  if (workspaceId === LOCAL_SCOPE.workspaceId) return `bot_${slug}`
  return `bot_${slug}_${createHash('sha256').update(workspaceId).digest('hex').slice(0, 8)}`
}

/**
 * A starter bot's configuration. Where the person seeding owns the workspace
 * alone (local mode, or their personal workspace) the bots keep their default
 * tools, as in A. In a team they start without host-reaching tools: any member
 * could drive them, and only an admin may grant those (spec §8).
 */
export function starterAssistant(entry: RosterEntry, scope: Scope): AssistantConfig {
  const assistant = rosterAssistant(entry)
  const ownedAlone = scope.workspaceId === LOCAL_SCOPE.workspaceId || scope.workspaceId === scope.actor.userId
  if (ownedAlone) return assistant
  return { ...assistant, tools: assistant.tools.filter((tool) => !HOST_TOOLS.includes(tool)) }
}
