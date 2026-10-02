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
 * A starter bot's configuration. In local mode, and in an operator's personal
 * workspace, the bots keep their default tools, as in A. Everywhere else they
 * start without host-reaching tools: in a team any member could drive them, and
 * in anyone else's personal workspace nobody who may grant them is present
 * (spec §8).
 */
export function starterAssistant(entry: RosterEntry, scope: Scope): AssistantConfig {
  const assistant = rosterAssistant(entry)
  const operatorAlone = scope.workspaceId === scope.actor.userId && scope.actor.operator === true
  if (scope.workspaceId === LOCAL_SCOPE.workspaceId || operatorAlone) return assistant
  return { ...assistant, tools: assistant.tools.filter((tool) => !HOST_TOOLS.includes(tool)) }
}
