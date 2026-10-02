import { createHash } from 'node:crypto'

/**
 * A starter bot's channel url. Channel urls are unique across the whole
 * instance (they name workspace folders and share links), so every workspace
 * but `local` gets its own suffix; `local` keeps A's urls (`bot_<slug>`).
 */
export function seedChannelUrl(slug: string, workspaceId: string): string {
  if (workspaceId === 'local') return `bot_${slug}`
  return `bot_${slug}_${createHash('sha256').update(workspaceId).digest('hex').slice(0, 8)}`
}
