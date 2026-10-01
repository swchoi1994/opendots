import { randomBytes } from 'node:crypto'
import { removeWorkspace } from '../bots/workspace'
import { groupScreensByTurn, screenImageUrl, type Screen } from '../domain/screen'
import { buildSeed, me } from '../domain/seed'
import { assertUsableSkill, parseSkillMarkdown, type Skill } from '../domain/skill'
import type { ChannelSummary, GroupChannel, Message, MessageWithReceipt } from '../domain/types'
import { botUserFor, unreadMemberCount } from '../domain/types'
import {
  ChannelFrozen,
  ChannelNotFound,
  EmptyChannelName,
  EmptyMessage,
  InvalidSkill,
  SkillNotFound,
  type ChatRepository,
  type CreateChannelInput,
  type Deployment,
} from './chat-repository'

/**
 * Bump whenever the Store shape changes.
 *
 * The store survives hot reloads by living on globalThis, which means a running
 * dev server can hold an object built by an older version of this file. Adding
 * a field would then read `undefined` at runtime while TypeScript insists it
 * exists — the version check forces a rebuild instead of inheriting a stale shape.
 */
const STORE_VERSION = 7

interface Store {
  version: number
  channels: Map<string, GroupChannel>
  messages: Map<string, Message[]>
  skills: Map<string, Skill>
  /** deployment id -> channelUrl, plus the reverse lookup to keep ids stable. */
  deployments: Map<string, Deployment>
  deploymentsByChannel: Map<string, string>
  /** channelUrl -> Agent SDK session id. */
  botSessions: Map<string, string>
  /** channelUrl -> screen frames captured during the bot's browser turns. */
  screens: Map<string, Screen[]>
  /** screenId -> the frame's JPEG path on disk; kept separate so it never leaks into a Screen returned to a caller. */
  screenPaths: Map<number, string | null>
  nextMessageId: number
  nextChannelId: number
  nextSkillId: number
  nextScreenId: number
}

/**
 * Dev servers re-evaluate modules on hot reload, which would otherwise reset
 * the conversation on every save. Parking the store on globalThis keeps it
 * alive across reloads within a single process.
 */
const globalForStore = globalThis as typeof globalThis & { __chatStore?: Store }

function createStore(): Store {
  const seed = buildSeed()
  return {
    version: STORE_VERSION,
    channels: new Map(seed.channels.map((channel) => [channel.channelUrl, channel])),
    messages: new Map(Object.entries(seed.messages)),
    skills: new Map(),
    deployments: new Map(),
    deploymentsByChannel: new Map(),
    botSessions: new Map(),
    screens: new Map(),
    screenPaths: new Map(),
    nextMessageId: 9000,
    nextChannelId: 1,
    nextSkillId: 1,
    nextScreenId: 1,
  }
}

function store(): Store {
  const existing = globalForStore.__chatStore
  if (existing && existing.version === STORE_VERSION) return existing

  const created = createStore()
  globalForStore.__chatStore = created
  return created
}

function toSummary(channel: GroupChannel): ChannelSummary {
  const { readReceipts: _receipts, ...summary } = channel
  return summary
}

function sortChannels(channels: GroupChannel[]): GroupChannel[] {
  return [...channels].sort((a, b) => {
    const aAt = a.lastMessage?.createdAt ?? a.createdAt
    const bAt = b.lastMessage?.createdAt ?? b.createdAt
    return bAt - aAt
  })
}

function requireChannel(channelUrl: string): GroupChannel {
  const channel = store().channels.get(channelUrl)
  if (!channel) throw ChannelNotFound(channelUrl)
  return channel
}

export const memoryRepository: ChatRepository = {
  async listChannels() {
    return sortChannels([...store().channels.values()]).map(toSummary)
  },

  async getChannel(channelUrl) {
    const channel = store().channels.get(channelUrl)
    return channel ? toSummary(channel) : null
  },

  async listMessages(channelUrl) {
    const channel = store().channels.get(channelUrl)
    if (!channel) return null
    const messages = store().messages.get(channelUrl) ?? []
    return messages
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map<MessageWithReceipt>((message) => ({
        message,
        unreadMemberCount: unreadMemberCount(channel, message),
      }))
  },

  async sendMessage(channelUrl, text) {
    const channel = requireChannel(channelUrl)
    if (channel.isFrozen) throw ChannelFrozen(channelUrl)

    const trimmed = text.trim()
    if (!trimmed) throw EmptyMessage()

    const current = store()
    const message: Message = {
      messageId: current.nextMessageId++,
      channelUrl,
      sender: me,
      message: trimmed,
      createdAt: Date.now(),
      messageType: 'user',
      sendingStatus: 'succeeded',
    }

    const thread = current.messages.get(channelUrl) ?? []
    thread.push(message)
    current.messages.set(channelUrl, thread)

    channel.lastMessage = message
    // Sending is an implicit read of everything before it.
    channel.readReceipts[me.userId] = message.createdAt
    channel.unreadMessageCount = 0

    return message
  },

  async appendAssistantMessage(channelUrl, text, provenance) {
    const channel = requireChannel(channelUrl)
    const current = store()

    const message: Message = {
      messageId: current.nextMessageId++,
      channelUrl,
      sender: channel.assistant ? botUserFor(channelUrl, channel.assistant) : me,
      message: text,
      createdAt: Date.now(),
      messageType: 'user',
      sendingStatus: 'succeeded',
      ...(provenance ? { provenance } : {}),
    }

    const thread = current.messages.get(channelUrl) ?? []
    thread.push(message)
    current.messages.set(channelUrl, thread)

    channel.lastMessage = message
    // The user is looking at the conversation they just posted into, so the
    // reply should not arrive already marked unread.
    channel.readReceipts[me.userId] = message.createdAt
    channel.readReceipts[message.sender.userId] = message.createdAt

    return message
  },

  async markRead(channelUrl) {
    const channel = requireChannel(channelUrl)
    channel.unreadMessageCount = 0
    channel.readReceipts[me.userId] = Date.now()
    return toSummary(channel)
  },

  async createChannel(input: CreateChannelInput) {
    const name = input.name.trim()
    if (!name) throw EmptyChannelName()

    const current = store()
    const channelUrl = `channel_assistant_${current.nextChannelId++}`
    const now = Date.now()
    const bot = botUserFor(channelUrl, input.assistant)

    const channel: GroupChannel = {
      channelUrl,
      name,
      // An assistant conversation is the user plus the bot itself.
      members: [me, bot],
      memberCount: 2,
      isFrozen: false,
      unreadMessageCount: 0,
      lastMessage: null,
      createdAt: now,
      assistant: input.assistant,
      readReceipts: { [me.userId]: now, [bot.userId]: now },
    }

    current.channels.set(channelUrl, channel)
    current.messages.set(channelUrl, [])
    return toSummary(channel)
  },

  async updateAssistant(channelUrl, assistant) {
    const channel = requireChannel(channelUrl)
    channel.assistant = assistant
    // The channel name IS the bot's name in the list; leaving it behind made a
    // rename half-apply — new name in the panel, old one in the sidebar.
    channel.name = assistant.name
    channel.members = [me, botUserFor(channelUrl, assistant)]
    return toSummary(channel)
  },

  async deleteChannel(channelUrl) {
    const current = store()
    if (!current.channels.has(channelUrl)) throw ChannelNotFound(channelUrl)
    current.channels.delete(channelUrl)
    // Drop the thread too, or the messages leak for the process lifetime.
    current.messages.delete(channelUrl)
    current.botSessions.delete(channelUrl)
    for (const screen of current.screens.get(channelUrl) ?? []) current.screenPaths.delete(screen.screenId)
    current.screens.delete(channelUrl)
    removeWorkspace(channelUrl)
  },

  async deleteAllChannels() {
    const current = store()
    const removed = current.channels.size
    for (const url of current.channels.keys()) removeWorkspace(url)
    current.botSessions.clear()
    current.channels.clear()
    current.messages.clear()
    current.screens.clear()
    current.screenPaths.clear()
    return removed
  },

  async deployChannel(channelUrl) {
    requireChannel(channelUrl)
    const current = store()

    /*
     * Deploying twice returns the same id. A share link that silently changed
     * every time you pressed the button would break every copy already sent.
     */
    const existingId = current.deploymentsByChannel.get(channelUrl)
    const existing = existingId ? current.deployments.get(existingId) : undefined
    if (existing) return existing

    // Base32-ish alphabet without look-alike characters, so a passcode read
    // aloud or retyped from a screenshot does not fail on 0/O or 1/I.
    const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
    const passcode = Array.from(
      randomBytes(8),
      (byte) => alphabet[byte % alphabet.length],
    ).join('')

    const deployment: Deployment = {
      id: randomBytes(8).toString('hex'),
      channelUrl,
      createdAt: Date.now(),
      passcode,
      allowPosting: true,
    }

    current.deployments.set(deployment.id, deployment)
    current.deploymentsByChannel.set(channelUrl, deployment.id)
    return deployment
  },

  async getDeployment(deploymentId) {
    return store().deployments.get(deploymentId) ?? null
  },

  async getBotSession(channelUrl) {
    return store().botSessions.get(channelUrl) ?? null
  },
  async setBotSession(channelUrl, sessionId) {
    requireChannel(channelUrl)
    store().botSessions.set(channelUrl, sessionId)
  },
  async clearBotSession(channelUrl) {
    store().botSessions.delete(channelUrl)
  },

  async appendScreen(input) {
    requireChannel(input.channelUrl)
    const current = store()
    const screenId = current.nextScreenId++
    const screen: Screen = {
      screenId, channelUrl: input.channelUrl, turnId: input.turnId, messageId: null, step: input.step,
      action: input.action, target: input.target, intent: input.intent, url: input.url, title: input.title,
      imageUrl: input.imagePath ? screenImageUrl(input.channelUrl, screenId) : null,
      annotations: input.annotations, flagged: input.flagged, createdAt: Date.now(),
    }
    current.screenPaths.set(screenId, input.imagePath)
    const list = current.screens.get(input.channelUrl) ?? []
    list.push(screen)
    current.screens.set(input.channelUrl, list)
    return screen
  },
  async listScreens(channelUrl, opts = {}) {
    const filtered = (store().screens.get(channelUrl) ?? []).filter((s) => !opts.turnId || s.turnId === opts.turnId)
    const sorted = groupScreensByTurn(filtered)
    return opts.limit ? sorted.slice(0, opts.limit) : sorted
  },
  async getScreenImagePath(channelUrl, screenId, opts = {}) {
    const screen = (store().screens.get(channelUrl) ?? []).find((s) => s.screenId === screenId)
    if (!screen || (opts.attachedOnly && screen.messageId === null)) return null
    return store().screenPaths.get(screenId) ?? null
  },
  async attachScreensToMessage(channelUrl, turnId, messageId) {
    for (const s of store().screens.get(channelUrl) ?? []) if (s.turnId === turnId) s.messageId = messageId
  },

  async listSkills() {
    return [...store().skills.values()].sort((a, b) => b.uploadedAt - a.uploadedAt)
  },

  async listSkillIds() {
    return [...store().skills.keys()]
  },

  async createSkill(input) {
    const parsed = parseSkillMarkdown(input.fileName, input.content)
    try {
      assertUsableSkill(parsed)
    } catch (error) {
      throw InvalidSkill(error instanceof Error ? error.message : 'Invalid skill file')
    }

    const current = store()
    const skill: Skill = {
      id: `skill_${current.nextSkillId++}`,
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      fileName: input.fileName,
      uploadedAt: Date.now(),
    }

    current.skills.set(skill.id, skill)
    return skill
  },

  async deleteSkill(skillId) {
    const current = store()
    if (!current.skills.delete(skillId)) throw SkillNotFound(skillId)
  },
}
