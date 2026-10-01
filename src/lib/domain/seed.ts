import { DEFAULT_ASSISTANT, type AssistantConfig } from './assistant'
import { ROSTER } from './roster'
import type { GroupChannel, Message, User, UserMessage } from './types'
import { CURRENT_USER_ID, botUserFor } from './types'

export const me: User = { userId: CURRENT_USER_ID, nickname: 'You', colorToken: 'violet' }

/**
 * Legacy sender for rows written before bots had names. Postgres rows with
 * sender_id `user_assistant` still resolve to this.
 */
export const assistantUser: User = {
  userId: 'user_assistant',
  nickname: 'Assistant',
  colorToken: 'emerald',
}

export function channelUrlFor(slug: string): string {
  return `bot_${slug}`
}

export function rosterAssistant(entry: (typeof ROSTER)[number]): AssistantConfig {
  return {
    ...DEFAULT_ASSISTANT,
    name: entry.name,
    avatar: entry.avatar,
    systemMessage: entry.systemMessage,
  }
}

/** Seed threads sit slightly in the past so live messages sort after them. */
function minutesAgo(minutes: number): number {
  return Date.now() - minutes * 60_000
}

export function buildSeed(): { channels: GroupChannel[]; messages: Record<string, Message[]> } {
  const channels: GroupChannel[] = []
  const messages: Record<string, Message[]> = {}

  ROSTER.forEach((entry, index) => {
    const channelUrl = channelUrlFor(entry.slug)
    const assistant = rosterAssistant(entry)
    const bot = botUserFor(channelUrl, assistant)
    const createdAt = minutesAgo(60 + index * 7)
    const intro: UserMessage = {
      messageId: 1000 + index,
      channelUrl,
      sender: bot,
      message: entry.intro,
      createdAt: createdAt + 1000,
      messageType: 'user',
      sendingStatus: 'succeeded',
    }
    channels.push({
      channelUrl,
      name: entry.name,
      members: [me, bot],
      memberCount: 2,
      isFrozen: false,
      unreadMessageCount: 0,
      lastMessage: intro,
      createdAt,
      assistant,
      readReceipts: { [me.userId]: Date.now(), [bot.userId]: Date.now() },
    })
    messages[channelUrl] = [intro]
  })

  return { channels, messages }
}

export type { Message } from './types'
