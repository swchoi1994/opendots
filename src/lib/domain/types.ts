/**
 * Domain model for the chat app.
 *
 * Field names intentionally mirror the shape of the original vendor SDK's
 * GroupChannel/BaseMessage model (memberCount, isFrozen, unreadMessageCount,
 * lastMessage, sendingStatus). Keeping the vocabulary means the UI written
 * against the old SDK maps over without translation, while none of the vendor
 * code or runtime remains.
 */

import type { AssistantConfig } from './assistant'

/** The bot's own identity as a message sender. One per bot channel. */
export function botUserFor(
  channelUrl: string,
  assistant: Pick<AssistantConfig, 'name' | 'avatar'>,
): User {
  return { userId: `bot_${channelUrl}`, nickname: assistant.name, colorToken: assistant.avatar.color }
}

export type SendingStatus = 'pending' | 'succeeded' | 'failed' | 'canceled'

export interface User {
  userId: string
  nickname: string
  /** Solid-colour avatar token; we render initials rather than remote images. */
  colorToken: string
}

/**
 * Where an assistant reply's grounding came from, shown under the bubble so a
 * reader can tell an answer drawn from uploaded skills apart from one the model
 * produced on its own.
 */
export interface MessageProvenance {
  route: string
  usedSkills: { id: string; title: string; source: string }[]
  usedBuiltInKnowledge: boolean
}

interface MessageBase {
  messageId: number
  channelUrl: string
  /** Epoch milliseconds. */
  createdAt: number
  sender: User
  sendingStatus: SendingStatus
  /** Present only on assistant replies. */
  provenance?: MessageProvenance
}

export interface UserMessage extends MessageBase {
  messageType: 'user'
  message: string
}

export interface FileMessage extends MessageBase {
  messageType: 'file'
  name: string
  /** Null means "no bytes stored" — we render a placeholder tile. */
  url: string | null
  type: string
  size: number
}

export type Message = UserMessage | FileMessage

export interface GroupChannel {
  channelUrl: string
  name: string
  members: User[]
  memberCount: number
  isFrozen: boolean
  unreadMessageCount: number
  lastMessage: Message | null
  createdAt: number
  /** Null for the seeded human conversations; set for assistant channels. */
  assistant: AssistantConfig | null
  /** userId -> epoch ms of that member's most recent read. */
  readReceipts: Record<string, number>
}

/** Channel as sent to the client: receipts collapsed away, ticks precomputed. */
export interface ChannelSummary {
  channelUrl: string
  name: string
  members: User[]
  memberCount: number
  isFrozen: boolean
  unreadMessageCount: number
  lastMessage: Message | null
  createdAt: number
  assistant: AssistantConfig | null
}

export interface MessageWithReceipt {
  message: Message
  /**
   * How many other members have NOT yet read this message.
   * Zero on an outgoing message renders the double check.
   */
  unreadMemberCount: number
}

export function isUserMessage(message: Message): message is UserMessage {
  return message.messageType === 'user'
}

export function isFileMessage(message: Message): message is FileMessage {
  return message.messageType === 'file'
}

/**
 * Members other than the sender who have not read this message yet.
 * Mirrors the SDK's getUnreadMemberCount(message).
 */
export function unreadMemberCount(channel: GroupChannel, message: Message): number {
  return channel.members.filter((member) => {
    if (member.userId === message.sender.userId) return false
    return (channel.readReceipts[member.userId] ?? 0) < message.createdAt
  }).length
}
