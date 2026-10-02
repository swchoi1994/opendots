import { DEFAULT_ASSISTANT, type AssistantConfig } from './assistant'
import { ROSTER } from './roster'
import type { User } from './types'

/**
 * Legacy sender for rows written before bots had names. Postgres rows with
 * sender_id `user_assistant` still resolve to this.
 */
export const assistantUser: User = {
  userId: 'user_assistant',
  nickname: 'Assistant',
  colorToken: 'emerald',
}

export function rosterAssistant(entry: (typeof ROSTER)[number]): AssistantConfig {
  return {
    ...DEFAULT_ASSISTANT,
    name: entry.name,
    avatar: entry.avatar,
    systemMessage: entry.systemMessage,
  }
}

export type { Message } from './types'
