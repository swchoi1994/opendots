import type { AssistantConfig } from '../domain/assistant'
import type { ProviderId } from '../domain/models'
import type { NewScreen, Screen } from '../domain/screen'
import type { Skill } from '../domain/skill'
import type {
  ChannelSummary,
  Message,
  MessageProvenance,
  MessageWithReceipt,
} from '../domain/types'

export interface CreateSkillInput {
  fileName: string
  content: string
}

/**
 * Whose data a repository instance works on, and who is acting.
 *
 * Every repository instance is bound to one scope: listings and lookups see
 * only `workspaceId`'s channels and documents (another workspace's channel is
 * reported exactly like a missing one), and messages and read receipts belong
 * to `actor`. `getRepository(scope)` builds one per request.
 */
export interface Scope {
  /** A Clerk organization id, a user's own id for their personal workspace, or `local`. */
  workspaceId: string
  /** `operator`: may grant host-reaching tools, so their own starter bots keep them. */
  actor: { userId: string; name: string; operator?: boolean }
}

/** Local mode, the tests and the eval: one workspace, one person. Mirrors auth/viewer.ts's LOCAL_VIEWER. */
export const LOCAL_SCOPE: Scope = { workspaceId: 'local', actor: { userId: 'user_me', name: 'You', operator: true } }

export interface Deployment {
  /** Opaque 16-hex-character id that appears in the shareable /app/<id> URL. */
  id: string
  channelUrl: string
  /** The channel's workspace: a share link acts in it, as a visitor. */
  workspaceId: string
  createdAt: number
  /**
   * Gate for the share link. A URL alone is a bearer token that leaks through
   * history, referrers, and forwarded messages — the passcode is what makes
   * "shareable" different from "public".
   */
  passcode: string
  /** When false the deployment is read-only for visitors. */
  allowPosting: boolean
}

/**
 * A share link acts in its channel's workspace as an anonymous visitor, one per
 * link, so a visitor's messages read "Visitor" and never pass for the owner's.
 */
export function visitorScope(deployment: Deployment): Scope {
  return { workspaceId: deployment.workspaceId, actor: { userId: `visitor_${deployment.id}`, name: 'Visitor' } }
}

export const DeploymentNotFound = (deploymentId: string) =>
  new RepositoryError(`No deployment with id "${deploymentId}"`, 404, 'DEPLOYMENT_NOT_FOUND')

/** A bot's Agent SDK session and the provider that created it (null: unknown, from before that was recorded). */
export interface BotSession {
  sessionId: string
  provider: ProviderId | null
}

export interface CreateChannelInput {
  name: string
  assistant: AssistantConfig
}

/**
 * The seam the rest of the app is written against.
 *
 * Route handlers depend on this interface only; the in-memory implementation is
 * the sole module that knows where the data actually lives. Swapping in a real
 * datastore later is a one-module change with no reach into the UI or routes.
 */
export interface ChatRepository {
  /** The workspace this instance sees and the person it acts as. */
  readonly scope: Scope

  listChannels(): Promise<ChannelSummary[]>
  getChannel(channelUrl: string): Promise<ChannelSummary | null>
  listMessages(channelUrl: string): Promise<MessageWithReceipt[] | null>
  sendMessage(channelUrl: string, text: string): Promise<Message>
  /** Appends a reply attributed to the assistant rather than the signed-in user. */
  appendAssistantMessage(
    channelUrl: string,
    text: string,
    provenance?: MessageProvenance,
  ): Promise<Message>
  markRead(channelUrl: string): Promise<ChannelSummary>
  createChannel(input: CreateChannelInput): Promise<ChannelSummary>
  /** Replaces the assistant configuration on an existing conversation. */
  updateAssistant(channelUrl: string, assistant: AssistantConfig): Promise<ChannelSummary>
  deleteChannel(channelUrl: string): Promise<void>
  /** Returns how many conversations were removed. */
  deleteAllChannels(): Promise<number>

  /** Mints (or returns the existing) shareable deployment id for a channel. */
  deployChannel(channelUrl: string): Promise<Deployment>
  getDeployment(deploymentId: string): Promise<Deployment | null>

  /** Agent SDK session for this bot, so context survives restarts. */
  getBotSession(channelUrl: string): Promise<BotSession | null>
  setBotSession(channelUrl: string, sessionId: string, provider: ProviderId): Promise<void>
  clearBotSession(channelUrl: string): Promise<void>

  appendScreen(input: NewScreen): Promise<Screen>
  /** Oldest first within a turn, turns newest first. */
  listScreens(channelUrl: string, opts?: { turnId?: string; limit?: number }): Promise<Screen[]>
  /**
   * The frame's JPEG path on disk, or null when no such frame exists in this
   * channel. `attachedOnly` additionally requires the frame to belong to a
   * stored reply (`messageId` set) — what a share-link visitor may see.
   */
  getScreenImagePath(
    channelUrl: string,
    screenId: number,
    opts?: { attachedOnly?: boolean },
  ): Promise<string | null>
  attachScreensToMessage(channelUrl: string, turnId: string, messageId: number): Promise<void>

  listSkills(): Promise<Skill[]>
  /** Ids only — cheap enough to poll for change without transferring every skill body. */
  listSkillIds(): Promise<string[]>
  createSkill(input: CreateSkillInput): Promise<Skill>
  deleteSkill(skillId: string): Promise<void>

  /**
   * Instance-wide, whatever this instance's scope: moves every channel and
   * document still in the `local` workspace into the claimant's personal
   * workspace, with what the local person sent and read now theirs, the first
   * time anyone calls it, and never again. Only operators call it.
   */
  claimLocalData(claimant: { userId: string; name: string }): Promise<'claimed' | 'already'>
}

/** Thrown for conditions the HTTP layer maps onto specific status codes. */
export class RepositoryError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = 'RepositoryError'
  }
}

export const ChannelNotFound = (channelUrl: string) =>
  new RepositoryError(`No channel with url "${channelUrl}"`, 404, 'CHANNEL_NOT_FOUND')

export const ChannelFrozen = (channelUrl: string) =>
  new RepositoryError(`Channel "${channelUrl}" is frozen`, 403, 'CHANNEL_FROZEN')

export const EmptyMessage = () =>
  new RepositoryError('Message text must not be empty', 400, 'EMPTY_MESSAGE')

export const EmptyChannelName = () =>
  new RepositoryError('Conversation name must not be empty', 400, 'EMPTY_CHANNEL_NAME')

export const SkillNotFound = (skillId: string) =>
  new RepositoryError(`No skill with id "${skillId}"`, 404, 'SKILL_NOT_FOUND')

export const InvalidSkill = (detail: string) =>
  new RepositoryError(detail, 400, 'INVALID_SKILL')
