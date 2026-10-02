import { randomBytes } from 'node:crypto'
import { removeWorkspace } from '../bots/workspace'
import { ROSTER } from '../domain/roster'
import { groupScreensByTurn, screenImageUrl, type Screen } from '../domain/screen'
import { assertUsableSkill, parseSkillMarkdown, type Skill } from '../domain/skill'
import type { ChannelSummary, GroupChannel, Message, MessageWithReceipt, User, UserMessage } from '../domain/types'
import { botUserFor, unreadMemberCount } from '../domain/types'
import {
  ChannelFrozen,
  ChannelNotFound,
  EmptyChannelName,
  EmptyMessage,
  InvalidSkill,
  LOCAL_SCOPE,
  SkillNotFound,
  type BotSession,
  type ChatRepository,
  type CreateChannelInput,
  type Deployment,
  type Scope,
} from './chat-repository'
import { seedChannelUrl, starterAssistant } from './starter-bots'

/**
 * Bump whenever the Store shape changes.
 *
 * The store survives hot reloads by living on globalThis, which means a running
 * dev server can hold an object built by an older version of this file. Adding
 * a field would then read `undefined` at runtime while TypeScript insists it
 * exists — the version check forces a rebuild instead of inheriting a stale shape.
 */
const STORE_VERSION = 8

/**
 * A channel as stored: the shared shape plus its workspace. `members` holds the
 * bot alone; each scope's summary puts its own person beside it.
 */
type StoredChannel = GroupChannel & { workspaceId: string }
type StoredSkill = Skill & { workspaceId: string }

interface Store {
  version: number
  channels: Map<string, StoredChannel>
  messages: Map<string, Message[]>
  skills: Map<string, StoredSkill>
  /** deployment id -> channelUrl, plus the reverse lookup to keep ids stable. */
  deployments: Map<string, Omit<Deployment, 'workspaceId'>>
  deploymentsByChannel: Map<string, string>
  /** channelUrl -> Agent SDK session and the provider that made it. */
  botSessions: Map<string, BotSession>
  /** channelUrl -> screen frames captured during the bot's browser turns. */
  screens: Map<string, Screen[]>
  /** screenId -> the frame's JPEG path on disk; kept separate so it never leaks into a Screen returned to a caller. */
  screenPaths: Map<number, string | null>
  /** Workspaces whose seeding this process has already settled, as the Postgres store remembers them. */
  seeded: Set<string>
  /** One-time decisions, as in the `instance_claims` table. */
  claims: Map<string, string>
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
  const created: Store = {
    version: STORE_VERSION,
    channels: new Map(),
    messages: new Map(),
    skills: new Map(),
    deployments: new Map(),
    deploymentsByChannel: new Map(),
    botSessions: new Map(),
    screens: new Map(),
    screenPaths: new Map(),
    seeded: new Set(),
    claims: new Map(),
    nextMessageId: 9000,
    nextChannelId: 1,
    nextSkillId: 1,
    nextScreenId: 1,
  }
  // `local` is seeded up front, as it was before workspaces: the eval and the
  // tests open a starter bot by url without listing first.
  seedIfEmpty(created, LOCAL_SCOPE)
  return created
}

function store(): Store {
  const existing = globalForStore.__chatStore
  if (existing && existing.version === STORE_VERSION) return existing

  const created = createStore()
  globalForStore.__chatStore = created
  return created
}

function sortChannels(channels: StoredChannel[]): StoredChannel[] {
  return [...channels].sort((a, b) => {
    const aAt = a.lastMessage?.createdAt ?? a.createdAt
    const bAt = b.lastMessage?.createdAt ?? b.createdAt
    return bAt - aAt
  })
}

function actorUser(scope: Scope): User {
  return { userId: scope.actor.userId, nickname: scope.actor.name, colorToken: 'violet' }
}

/**
 * The Postgres store's rule: the first listing in a process seeds the nine
 * starter bots into a workspace that has no channels, each intro already read
 * by the person who listed. All nine or none: if any of the urls is held — after
 * a claim, the claimed bots keep `local`'s urls — the workspace gets none, rather
 * than whichever bots the claimant happened to delete.
 */
function seedIfEmpty(current: Store, scope: Scope): void {
  if (current.seeded.has(scope.workspaceId)) return
  current.seeded.add(scope.workspaceId)
  if ([...current.channels.values()].some((channel) => channel.workspaceId === scope.workspaceId)) return
  if (ROSTER.some((entry) => current.channels.has(seedChannelUrl(entry.slug, scope.workspaceId)))) return
  ROSTER.forEach((entry, index) => {
    const channelUrl = seedChannelUrl(entry.slug, scope.workspaceId)
    const assistant = starterAssistant(entry, scope)
    const bot = botUserFor(channelUrl, assistant)
    // Slightly in the past, so live messages sort after the intros.
    const createdAt = Date.now() - (60 + index * 7) * 60_000
    const intro: UserMessage = {
      messageId: current.nextMessageId++,
      channelUrl,
      sender: bot,
      message: entry.intro,
      createdAt: createdAt + 1000,
      messageType: 'user',
      sendingStatus: 'succeeded',
    }
    current.channels.set(channelUrl, {
      channelUrl,
      name: entry.name,
      members: [bot],
      memberCount: 2,
      isFrozen: false,
      unreadMessageCount: 0,
      lastMessage: intro,
      createdAt,
      assistant,
      readReceipts: { [scope.actor.userId]: Date.now(), [bot.userId]: Date.now() },
      workspaceId: scope.workspaceId,
    })
    current.messages.set(channelUrl, [intro])
  })
}

/** Drops a channel and everything hanging off it, as ON DELETE CASCADE does in Postgres. */
function dropChannel(current: Store, channelUrl: string): void {
  current.channels.delete(channelUrl)
  current.messages.delete(channelUrl)
  current.botSessions.delete(channelUrl)
  for (const screen of current.screens.get(channelUrl) ?? []) current.screenPaths.delete(screen.screenId)
  current.screens.delete(channelUrl)
  const deploymentId = current.deploymentsByChannel.get(channelUrl)
  if (deploymentId) current.deployments.delete(deploymentId)
  current.deploymentsByChannel.delete(channelUrl)
  removeWorkspace(channelUrl)
}

/**
 * A memory store bound to one scope. All instances share the same process-wide
 * data; the scope decides what each one can see and who it acts as.
 */
export function createMemoryRepository(scope: Scope): ChatRepository {
  const me = actorUser(scope)

  /** The channel, if it exists in this scope's workspace. */
  function own(channelUrl: string): StoredChannel | null {
    const channel = store().channels.get(channelUrl)
    return channel && channel.workspaceId === scope.workspaceId ? channel : null
  }

  function requireChannel(channelUrl: string): StoredChannel {
    const channel = own(channelUrl)
    if (!channel) throw ChannelNotFound(channelUrl)
    return channel
  }

  function membersOf(channel: StoredChannel): User[] {
    return channel.assistant ? [me, botUserFor(channel.channelUrl, channel.assistant)] : [me]
  }

  /** The channel as this scope's person sees it: their own unread count, and them beside the bot. */
  function toSummary(channel: StoredChannel): ChannelSummary {
    const { readReceipts, workspaceId: _workspace, ...summary } = channel
    const readAt = readReceipts[me.userId] ?? 0
    const unread = (store().messages.get(channel.channelUrl) ?? []).filter(
      (message) => message.sender.userId !== me.userId && message.createdAt > readAt,
    ).length
    return { ...summary, members: membersOf(channel), unreadMessageCount: unread }
  }

  function ownSkill(skillId: string): StoredSkill | null {
    const skill = store().skills.get(skillId)
    return skill && skill.workspaceId === scope.workspaceId ? skill : null
  }

  function publicSkill({ workspaceId: _workspace, ...skill }: StoredSkill): Skill {
    return skill
  }

  return {
    scope,

    async listChannels() {
      seedIfEmpty(store(), scope)
      const mine = [...store().channels.values()].filter((channel) => channel.workspaceId === scope.workspaceId)
      return sortChannels(mine).map(toSummary)
    },

    async getChannel(channelUrl) {
      const channel = own(channelUrl)
      return channel ? toSummary(channel) : null
    },

    async listMessages(channelUrl) {
      const channel = own(channelUrl)
      if (!channel) return null
      const view = { ...channel, members: membersOf(channel) }
      return (store().messages.get(channelUrl) ?? [])
        .slice()
        .sort((a, b) => a.createdAt - b.createdAt)
        .map<MessageWithReceipt>((message) => ({ message, unreadMemberCount: unreadMemberCount(view, message) }))
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
      // The person who asked is looking at the conversation, so the reply
      // should not arrive already unread for them.
      channel.readReceipts[me.userId] = message.createdAt
      channel.readReceipts[message.sender.userId] = message.createdAt
      return message
    },

    async markRead(channelUrl) {
      const channel = requireChannel(channelUrl)
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
      const channel: StoredChannel = {
        channelUrl,
        name,
        members: [bot],
        memberCount: 2,
        isFrozen: false,
        unreadMessageCount: 0,
        lastMessage: null,
        createdAt: now,
        assistant: input.assistant,
        readReceipts: { [me.userId]: now, [bot.userId]: now },
        workspaceId: scope.workspaceId,
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
      channel.members = [botUserFor(channelUrl, assistant)]
      return toSummary(channel)
    },

    async deleteChannel(channelUrl) {
      requireChannel(channelUrl)
      const current = store()
      dropChannel(current, channelUrl)
      // Deleting the last bot empties the workspace; the next listing may seed it again.
      current.seeded.delete(scope.workspaceId)
    },

    async deleteAllChannels() {
      const current = store()
      const mine = [...current.channels.values()].filter((channel) => channel.workspaceId === scope.workspaceId)
      for (const { channelUrl } of mine) dropChannel(current, channelUrl)
      // The workspace is empty now; the next listing may seed it again.
      current.seeded.delete(scope.workspaceId)
      return mine.length
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
      if (existing) return { ...existing, workspaceId: scope.workspaceId }

      // Base32-ish alphabet without look-alike characters, so a passcode read
      // aloud or retyped from a screenshot does not fail on 0/O or 1/I.
      const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
      const passcode = Array.from(randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join('')
      const deployment = { id: randomBytes(8).toString('hex'), channelUrl, createdAt: Date.now(), passcode, allowPosting: true }
      current.deployments.set(deployment.id, deployment)
      current.deploymentsByChannel.set(channelUrl, deployment.id)
      return { ...deployment, workspaceId: scope.workspaceId }
    },

    async getDeployment(deploymentId) {
      // Deliberately unscoped: a share link is opened by someone outside the workspace.
      const current = store()
      const deployment = current.deployments.get(deploymentId)
      const channel = deployment ? current.channels.get(deployment.channelUrl) : undefined
      return deployment && channel ? { ...deployment, workspaceId: channel.workspaceId } : null
    },

    async getBotSession(channelUrl) {
      if (!own(channelUrl)) return null
      const session = store().botSessions.get(channelUrl)
      return session ? { ...session } : null
    },
    async setBotSession(channelUrl, sessionId, provider) {
      requireChannel(channelUrl)
      store().botSessions.set(channelUrl, { sessionId, provider })
    },
    async clearBotSession(channelUrl) {
      if (own(channelUrl)) store().botSessions.delete(channelUrl)
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
      if (!own(channelUrl)) return []
      const filtered = (store().screens.get(channelUrl) ?? []).filter((s) => !opts.turnId || s.turnId === opts.turnId)
      const sorted = groupScreensByTurn(filtered)
      return opts.limit ? sorted.slice(0, opts.limit) : sorted
    },
    async getScreenImagePath(channelUrl, screenId, opts = {}) {
      if (!own(channelUrl)) return null
      const screen = (store().screens.get(channelUrl) ?? []).find((s) => s.screenId === screenId)
      if (!screen || (opts.attachedOnly && screen.messageId === null)) return null
      return store().screenPaths.get(screenId) ?? null
    },
    async attachScreensToMessage(channelUrl, turnId, messageId) {
      if (!own(channelUrl)) return
      for (const s of store().screens.get(channelUrl) ?? []) if (s.turnId === turnId) s.messageId = messageId
    },

    async listSkills() {
      return [...store().skills.values()]
        .filter((skill) => skill.workspaceId === scope.workspaceId)
        .sort((a, b) => b.uploadedAt - a.uploadedAt)
        .map(publicSkill)
    },

    async listSkillIds() {
      return [...store().skills.values()].filter((skill) => skill.workspaceId === scope.workspaceId).map((skill) => skill.id)
    },

    async createSkill(input) {
      const parsed = parseSkillMarkdown(input.fileName, input.content)
      try {
        assertUsableSkill(parsed)
      } catch (error) {
        throw InvalidSkill(error instanceof Error ? error.message : 'Invalid skill file')
      }
      const current = store()
      const skill: StoredSkill = {
        id: `skill_${current.nextSkillId++}`,
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
        fileName: input.fileName,
        uploadedAt: Date.now(),
        workspaceId: scope.workspaceId,
      }
      current.skills.set(skill.id, skill)
      return publicSkill(skill)
    },

    async deleteSkill(skillId) {
      if (!ownSkill(skillId)) throw SkillNotFound(skillId)
      store().skills.delete(skillId)
    },

    async claimLocalData({ userId, name }) {
      const current = store()
      if (current.claims.has('local_data')) return 'already'
      current.claims.set('local_data', userId)
      const localPerson = LOCAL_SCOPE.actor.userId
      for (const channel of current.channels.values()) {
        if (channel.workspaceId !== LOCAL_SCOPE.workspaceId) continue
        channel.workspaceId = userId
        // They were the local person: what that person had read, they have read.
        const readAt = channel.readReceipts[localPerson]
        if (readAt !== undefined) channel.readReceipts[userId] = Math.max(channel.readReceipts[userId] ?? 0, readAt)
        // And what they sent is theirs. In place, so lastMessage, the same object, follows.
        for (const message of current.messages.get(channel.channelUrl) ?? []) {
          if (message.sender.userId === localPerson) message.sender = { ...message.sender, userId, nickname: name }
        }
      }
      for (const skill of current.skills.values()) if (skill.workspaceId === LOCAL_SCOPE.workspaceId) skill.workspaceId = userId
      return 'claimed'
    },
  }
}

/** The local scope's store: what local mode, the tests and the eval use. */
export const memoryRepository: ChatRepository = createMemoryRepository(LOCAL_SCOPE)
