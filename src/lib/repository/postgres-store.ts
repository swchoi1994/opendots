import { randomBytes } from 'node:crypto'
import { removeWorkspace } from '../bots/workspace'
import { DEFAULT_ASSISTANT, HOST_TOOLS, parseAssistantConfig, type AssistantConfig } from '../domain/assistant'
import { ROSTER } from '../domain/roster'
import { groupScreensByTurn, screenImageUrl, type NewScreen, type Screen } from '../domain/screen'
import { assistantUser } from '../domain/seed'
import { assertUsableSkill, parseSkillMarkdown, type Skill } from '../domain/skill'
import type {
  ChannelSummary,
  Message,
  MessageProvenance,
  MessageWithReceipt,
  User,
  UserMessage,
} from '../domain/types'
import { botUserFor } from '../domain/types'
import type { ProviderId } from '../domain/models'
import { getDb, type Db } from '../db'
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
  type CreateSkillInput,
  type Deployment,
  type Scope,
} from './chat-repository'
import { seedChannelUrl, starterAssistant } from './starter-bots'

/**
 * Postgres-backed ChatRepository (exercise 5).
 *
 * Every route depends on the ChatRepository INTERFACE, so this class is the
 * whole migration off in-memory storage: no route or component changes.
 *
 * Decisions worth naming:
 *   - Rows are copies, not shared references, so the in-memory footgun (a caller
 *     mutating a live object) simply cannot happen here.
 *   - unreadMessageCount / unreadMemberCount are COMPUTED from read_receipts on
 *     read. That is a subquery per channel (list) or a small per-message pass
 *     (thread). At this scale it is fine; at 10k+ messages a materialised
 *     counter would be the next move.
 *   - An instance is bound to one Scope. Every query filters by its workspace,
 *     so another workspace's channel looks exactly like a missing one, and the
 *     scope's person is who sends, reads and is counted as unread.
 */

/** A person keeps the name they sent with; the bot is always shown as it is now. */
function userFor(senderId: string, senderName: string, bot: User | null): User {
  if (bot && senderId === bot.userId) return bot
  if (senderId === assistantUser.userId) return { ...assistantUser, nickname: bot?.nickname ?? senderName }
  return { userId: senderId, nickname: senderName, colorToken: 'violet' }
}

function actorUser(scope: Scope): User {
  return { userId: scope.actor.userId, nickname: scope.actor.name, colorToken: 'violet' }
}

interface MessageRow {
  message_id: string
  channel_url: string
  sender_id: string
  sender_name: string
  body: string
  provenance: MessageProvenance | null
  created_at: Date
}

function rowToMessage(row: MessageRow, bot: User | null): UserMessage {
  return {
    messageId: Number(row.message_id),
    channelUrl: row.channel_url,
    sender: userFor(row.sender_id, row.sender_name, bot),
    message: row.body,
    createdAt: new Date(row.created_at).getTime(),
    messageType: 'user',
    sendingStatus: 'succeeded',
    ...(row.provenance ? { provenance: row.provenance } : {}),
  }
}

interface ChannelRow {
  channel_url: string
  name: string
  member_count: number
  is_frozen: boolean
  assistant: ChannelSummary['assistant']
  created_at: Date
  lm_id: string | null
  lm_sender_id: string | null
  lm_sender_name: string | null
  lm_body: string | null
  lm_provenance: MessageProvenance | null
  lm_created_at: Date | null
  unread_count: number
}

/**
 * A stored bot whose row has no tool list (written before tools existed) gets
 * the default tools minus the host-reaching ones: parsing fills a missing list
 * with every default, and no admin ever granted those to this bot.
 */
const STORED_FALLBACK_TOOLS = DEFAULT_ASSISTANT.tools.filter((tool) => !HOST_TOOLS.includes(tool))

function storedAssistant(raw: ChannelRow['assistant'], name: string): AssistantConfig | null {
  if (!raw) return null
  const record = raw as unknown as Record<string, unknown>
  return parseAssistantConfig(Array.isArray(record.tools) ? raw : { ...record, tools: STORED_FALLBACK_TOOLS }, name)
}

function rowToSummary(row: ChannelRow, actor: User): ChannelSummary {
  const assistant = storedAssistant(row.assistant, row.name)
  const bot = assistant ? botUserFor(row.channel_url, assistant) : null

  const lastMessage: Message | null = row.lm_id
    ? rowToMessage(
        {
          message_id: row.lm_id,
          channel_url: row.channel_url,
          sender_id: row.lm_sender_id!,
          sender_name: row.lm_sender_name!,
          body: row.lm_body!,
          provenance: row.lm_provenance,
          created_at: row.lm_created_at!,
        },
        bot,
      )
    : null

  return {
    channelUrl: row.channel_url,
    name: row.name,
    members: bot ? [actor, bot] : [actor],
    memberCount: row.member_count,
    isFrozen: row.is_frozen,
    unreadMessageCount: row.unread_count,
    lastMessage,
    createdAt: new Date(row.created_at).getTime(),
    assistant,
  }
}

interface ScreenRow {
  screen_id: string
  channel_url: string
  turn_id: string
  message_id: string | null
  step: number
  action: string
  target: string | null
  intent: string | null
  url: string
  title: string
  image_path: string | null
  annotations: Screen['annotations']
  flagged: boolean
  created_at: Date
}

function rowToScreen(row: ScreenRow): Screen {
  return {
    screenId: Number(row.screen_id),
    channelUrl: row.channel_url,
    turnId: row.turn_id,
    messageId: row.message_id === null ? null : Number(row.message_id),
    step: row.step,
    action: row.action,
    target: row.target,
    intent: row.intent,
    url: row.url,
    title: row.title,
    imageUrl: row.image_path ? screenImageUrl(row.channel_url, Number(row.screen_id)) : null,
    annotations: row.annotations,
    flagged: row.flagged,
    createdAt: new Date(row.created_at).getTime(),
  }
}

// Selects the workspace's channels ($2), each with its last message (LATERAL)
// and the acting person's ($1) unread count, in one round trip.
const CHANNEL_SELECT = `
  SELECT c.channel_url, c.name, c.member_count, c.is_frozen, c.assistant, c.created_at,
         m.message_id AS lm_id, m.sender_id AS lm_sender_id, m.sender_name AS lm_sender_name,
         m.body AS lm_body, m.provenance AS lm_provenance, m.created_at AS lm_created_at,
         (
           SELECT COUNT(*)::int FROM messages um
            WHERE um.channel_url = c.channel_url
              AND um.sender_id <> $1
              AND um.created_at > COALESCE(
                (SELECT r.read_at FROM read_receipts r
                  WHERE r.channel_url = c.channel_url AND r.user_id = $1),
                to_timestamp(0))
         ) AS unread_count
    FROM channels c
    LEFT JOIN LATERAL (
      SELECT * FROM messages mm WHERE mm.channel_url = c.channel_url
       ORDER BY mm.created_at DESC, mm.message_id DESC LIMIT 1
    ) m ON TRUE
   WHERE c.workspace_id = $2
`

/** The scoped instance's channel filter, for tables that hang off a channel. */
const IN_WORKSPACE = 'channel_url IN (SELECT channel_url FROM channels WHERE workspace_id = $2)'

interface DeploymentRow {
  deployment_id: string
  channel_url: string
  workspace_id: string
  passcode: string
  allow_posting: boolean
  created_at: Date
}

function rowToDeployment(row: DeploymentRow): Deployment {
  return {
    id: row.deployment_id,
    channelUrl: row.channel_url,
    workspaceId: row.workspace_id,
    createdAt: new Date(row.created_at).getTime(),
    passcode: row.passcode,
    allowPosting: row.allow_posting,
  }
}

/**
 * Workspaces whose seeding this process has already settled, per database.
 * Module-level rather than per instance: routes build a repository per request.
 */
const seededByDb = new WeakMap<Db, Set<string>>()

export class PostgresChatRepository implements ChatRepository {
  private readonly me: User

  /** Tests inject an in-memory PGlite; the app uses the process-wide database (PGlite or a server). */
  constructor(
    private readonly injected?: Db,
    readonly scope: Scope = LOCAL_SCOPE,
  ) {
    this.me = actorUser(scope)
  }

  private get db(): Db {
    return this.injected ?? getDb()
  }

  private get workspaceId(): string {
    return this.scope.workspaceId
  }

  private seeded(): Set<string> {
    let seeded = seededByDb.get(this.db)
    if (!seeded) {
      seeded = new Set()
      seededByDb.set(this.db, seeded)
    }
    return seeded
  }

  /** The channel, if it is in this scope's workspace; anything else is reported as missing. */
  private async requireChannel(channelUrl: string): Promise<{ isFrozen: boolean }> {
    const { rows } = await this.db.query<{ is_frozen: boolean }>(
      'SELECT is_frozen FROM channels WHERE channel_url = $1 AND workspace_id = $2',
      [channelUrl, this.workspaceId],
    )
    if (rows.length === 0) throw ChannelNotFound(channelUrl)
    return { isFrozen: rows[0]!.is_frozen }
  }

  /**
   * Seeds the nine-bot roster into an empty workspace on its first listing, so
   * a fresh `docker compose up`, a new team or a wiped workspace gets the same
   * starting point as the in-memory store without a separate seed script.
   */
  private async seedIfEmpty(): Promise<void> {
    const seeded = this.seeded()
    if (seeded.has(this.workspaceId) || process.env.SEED_BOTS === '0') return

    await this.db.transaction(async (tx) => {
      // Advisory lock scoped to this transaction and this workspace: a second
      // concurrent seeder (another request, or another instance on the same
      // server) blocks here until this one commits, so "check empty, then
      // insert" cannot interleave.
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('opendots_seed:' || $1::text))", [this.workspaceId])

      const { rows } = await tx.query<{ n: string }>(
        'SELECT COUNT(*)::text AS n FROM channels WHERE workspace_id = $1',
        [this.workspaceId],
      )
      if (Number(rows[0]?.n ?? '0') > 0) return

      // All nine or none: after a claim the claimed bots keep `local`'s urls, and
      // a partial set would be whichever bots the claimant happened to delete.
      const urls = ROSTER.map((entry) => seedChannelUrl(entry.slug, this.workspaceId))
      const taken = await tx.query('SELECT 1 FROM channels WHERE channel_url = ANY($1::text[]) LIMIT 1', [urls])
      if (taken.rows.length > 0) return

      for (const entry of ROSTER) {
        const channelUrl = seedChannelUrl(entry.slug, this.workspaceId)
        const assistant = starterAssistant(entry, this.scope)
        const bot = botUserFor(channelUrl, assistant)
        const inserted = await tx.query(
          `INSERT INTO channels (channel_url, name, member_count, is_frozen, assistant, workspace_id)
           VALUES ($1, $2, 2, FALSE, $3, $4) ON CONFLICT (channel_url) DO NOTHING RETURNING channel_url`,
          [channelUrl, entry.name, JSON.stringify(assistant), this.workspaceId],
        )
        // Belt and braces: the check above already found every url free.
        if (inserted.rows.length === 0) continue
        await tx.query(
          `INSERT INTO messages (channel_url, sender_id, sender_name, body, message_type)
           VALUES ($1, $2, $3, $4, 'user')`,
          [channelUrl, bot.userId, bot.nickname, entry.intro],
        )
        await tx.query(
          `INSERT INTO read_receipts (channel_url, user_id, read_at) VALUES ($1, $2, NOW()), ($1, $3, NOW())
           ON CONFLICT (channel_url, user_id) DO UPDATE SET read_at = EXCLUDED.read_at`,
          [channelUrl, this.me.userId, bot.userId],
        )
      }
    })
    seeded.add(this.workspaceId)
  }

  async listChannels(): Promise<ChannelSummary[]> {
    await this.seedIfEmpty()
    const { rows } = await this.db.query<ChannelRow>(
      `${CHANNEL_SELECT} ORDER BY COALESCE(m.created_at, c.created_at) DESC`,
      [this.me.userId, this.workspaceId],
    )
    return rows.map((row) => rowToSummary(row, this.me))
  }

  async getChannel(channelUrl: string): Promise<ChannelSummary | null> {
    const { rows } = await this.db.query<ChannelRow>(
      `${CHANNEL_SELECT} AND c.channel_url = $3`,
      [this.me.userId, this.workspaceId, channelUrl],
    )
    return rows[0] ? rowToSummary(rows[0], this.me) : null
  }

  async listMessages(channelUrl: string): Promise<MessageWithReceipt[] | null> {
    // Null (no channel) vs [] (channel, no messages) — the routes map that to 404 vs 200.
    const channel = await this.getChannel(channelUrl)
    if (!channel) return null
    const bot = channel.assistant ? botUserFor(channelUrl, channel.assistant) : null
    const members = channel.members

    const [{ rows: messages }, { rows: receipts }] = await Promise.all([
      this.db.query<MessageRow>(
        'SELECT * FROM messages WHERE channel_url = $1 ORDER BY created_at ASC, message_id ASC',
        [channelUrl],
      ),
      this.db.query<{ user_id: string; read_at: Date }>(
        'SELECT user_id, read_at FROM read_receipts WHERE channel_url = $1',
        [channelUrl],
      ),
    ])

    const readAt = new Map(receipts.map((r) => [r.user_id, new Date(r.read_at).getTime()]))

    return messages.map((row) => {
      const message = rowToMessage(row, bot)
      const unreadMemberCount = members.filter(
        (member) =>
          member.userId !== message.sender.userId &&
          (readAt.get(member.userId) ?? 0) < message.createdAt,
      ).length
      return { message, unreadMemberCount }
    })
  }

  async sendMessage(channelUrl: string, text: string): Promise<Message> {
    const { isFrozen } = await this.requireChannel(channelUrl)
    if (isFrozen) throw ChannelFrozen(channelUrl)
    const trimmed = text.trim()
    if (!trimmed) throw EmptyMessage()

    const { rows } = await this.db.query<MessageRow>(
      `INSERT INTO messages (channel_url, sender_id, sender_name, body, message_type)
       VALUES ($1, $2, $3, $4, 'user')
       RETURNING message_id, channel_url, sender_id, sender_name, body, provenance, created_at`,
      [channelUrl, this.me.userId, this.me.nickname, trimmed],
    )
    const message = rowToMessage(rows[0]!, null)
    // Sending is an implicit read of everything up to it.
    await this.setReadReceipt(channelUrl, this.me.userId)
    return message
  }

  async appendAssistantMessage(
    channelUrl: string,
    text: string,
    provenance?: MessageProvenance,
  ): Promise<Message> {
    const channel = await this.getChannel(channelUrl)
    if (!channel) throw ChannelNotFound(channelUrl)
    const bot = channel.assistant ? botUserFor(channelUrl, channel.assistant) : this.me
    const { rows } = await this.db.query<MessageRow>(
      `INSERT INTO messages (channel_url, sender_id, sender_name, body, message_type, provenance)
       VALUES ($1, $2, $3, $4, 'user', $5)
       RETURNING message_id, channel_url, sender_id, sender_name, body, provenance, created_at`,
      [channelUrl, bot.userId, bot.nickname, text, provenance ? JSON.stringify(provenance) : null],
    )
    const message = rowToMessage(rows[0]!, bot)
    // The person who asked is looking at the conversation, so the reply should
    // not arrive already marked unread for them; and the bot has "read" up to
    // its own reply, so their messages show the double check.
    await Promise.all([
      this.setReadReceipt(channelUrl, this.me.userId),
      this.setReadReceipt(channelUrl, bot.userId),
    ])
    return message
  }

  // Marks "read up to now" using the DB clock. Using NOW() rather than a
  // JS millisecond value avoids a precision mismatch: message timestamps are
  // stored at microsecond precision, so a ms-truncated receipt would leave the
  // just-read message counting as still-unread.
  private async setReadReceipt(channelUrl: string, userId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO read_receipts (channel_url, user_id, read_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (channel_url, user_id) DO UPDATE SET read_at = EXCLUDED.read_at`,
      [channelUrl, userId],
    )
  }

  async markRead(channelUrl: string): Promise<ChannelSummary> {
    await this.requireChannel(channelUrl)
    await this.setReadReceipt(channelUrl, this.me.userId)
    return (await this.getChannel(channelUrl))!
  }

  async createChannel(input: CreateChannelInput): Promise<ChannelSummary> {
    const name = input.name.trim()
    if (!name) throw EmptyChannelName()

    const channelUrl = `channel_assistant_${randomBytes(6).toString('hex')}`
    await this.db.query(
      `INSERT INTO channels (channel_url, name, member_count, is_frozen, assistant, workspace_id)
       VALUES ($1, $2, 2, FALSE, $3, $4)`,
      [channelUrl, name, JSON.stringify(input.assistant), this.workspaceId],
    )
    await this.setReadReceipt(channelUrl, this.me.userId)
    return (await this.getChannel(channelUrl))!
  }

  async updateAssistant(channelUrl: string, assistant: AssistantConfig): Promise<ChannelSummary> {
    // The name travels with the config: the channel name is what the sidebar
    // renders, so updating only the JSON made a rename half-apply.
    const { rowCount } = await this.db.query(
      'UPDATE channels SET assistant = $3, name = $4 WHERE channel_url = $1 AND workspace_id = $2',
      [channelUrl, this.workspaceId, JSON.stringify(assistant), assistant.name],
    )
    if (!rowCount) throw ChannelNotFound(channelUrl)
    return (await this.getChannel(channelUrl))!
  }

  async deleteChannel(channelUrl: string): Promise<void> {
    // ON DELETE CASCADE removes the channel's messages, receipts, deployment and bot session.
    const { rowCount } = await this.db.query(
      'DELETE FROM channels WHERE channel_url = $1 AND workspace_id = $2',
      [channelUrl, this.workspaceId],
    )
    if (!rowCount) throw ChannelNotFound(channelUrl)
    removeWorkspace(channelUrl)
    // Deleting can empty the workspace, and `seeded` is what stops the lazy
    // roster seed from ever looking again. Leave it latched and a wiped
    // workspace stays empty for the life of the process.
    this.seeded().delete(this.workspaceId)
  }

  async deleteAllChannels(): Promise<number> {
    const { rows } = await this.db.query<{ channel_url: string }>(
      'DELETE FROM channels WHERE workspace_id = $1 RETURNING channel_url',
      [this.workspaceId],
    )
    for (const r of rows) removeWorkspace(r.channel_url)
    // The workspace is now empty by construction: the next request must be
    // allowed to re-seed the roster.
    this.seeded().delete(this.workspaceId)
    return rows.length
  }

  async deployChannel(channelUrl: string): Promise<Deployment> {
    await this.requireChannel(channelUrl)

    const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
    const passcode = Array.from(randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join('')
    const id = randomBytes(8).toString('hex')

    // Deploying twice must return the SAME id — the no-op UPDATE returns the
    // existing row rather than minting a new one (unique index on channel_url).
    const { rows } = await this.db.query<Omit<DeploymentRow, 'workspace_id'>>(
      `INSERT INTO deployments (deployment_id, channel_url, passcode, allow_posting)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (channel_url) DO UPDATE SET channel_url = EXCLUDED.channel_url
       RETURNING deployment_id, channel_url, passcode, allow_posting, created_at`,
      [id, channelUrl, passcode],
    )
    return rowToDeployment({ ...rows[0]!, workspace_id: this.workspaceId })
  }

  /** Deliberately unscoped: a share link is opened by someone outside the workspace. */
  async getDeployment(deploymentId: string): Promise<Deployment | null> {
    const { rows } = await this.db.query<DeploymentRow>(
      `SELECT d.deployment_id, d.channel_url, c.workspace_id, d.passcode, d.allow_posting, d.created_at
         FROM deployments d JOIN channels c ON c.channel_url = d.channel_url
        WHERE d.deployment_id = $1`,
      [deploymentId],
    )
    return rows[0] ? rowToDeployment(rows[0]) : null
  }

  async getBotSession(channelUrl: string): Promise<BotSession | null> {
    const { rows } = await this.db.query<{ session_id: string; provider: string | null }>(
      `SELECT session_id, provider FROM bot_sessions WHERE channel_url = $1 AND ${IN_WORKSPACE}`,
      [channelUrl, this.workspaceId],
    )
    const row = rows[0]
    if (!row) return null
    const provider = row.provider === 'anthropic' || row.provider === 'ollama' ? row.provider : null
    return { sessionId: row.session_id, provider }
  }

  async setBotSession(channelUrl: string, sessionId: string, provider: ProviderId): Promise<void> {
    await this.requireChannel(channelUrl)
    await this.db.query(
      `INSERT INTO bot_sessions (channel_url, session_id, provider, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (channel_url) DO UPDATE
         SET session_id = EXCLUDED.session_id, provider = EXCLUDED.provider, updated_at = NOW()`,
      [channelUrl, sessionId, provider],
    )
  }

  async clearBotSession(channelUrl: string): Promise<void> {
    await this.db.query(`DELETE FROM bot_sessions WHERE channel_url = $1 AND ${IN_WORKSPACE}`, [
      channelUrl,
      this.workspaceId,
    ])
  }

  async appendScreen(input: NewScreen): Promise<Screen> {
    await this.requireChannel(input.channelUrl)
    const { rows } = await this.db.query<ScreenRow>(
      `INSERT INTO screens (channel_url, turn_id, step, action, target, intent, url, title, image_path, annotations, flagged)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        input.channelUrl,
        input.turnId,
        input.step,
        input.action,
        input.target,
        input.intent,
        input.url,
        input.title,
        input.imagePath,
        JSON.stringify(input.annotations),
        input.flagged,
      ],
    )
    return rowToScreen(rows[0]!)
  }

  /**
   * Newest frames first out of the database, then regrouped in JS.
   *
   * The SQL takes only the newest `limit` rows rather than every frame the
   * channel ever produced — a long-lived browsing bot accumulates thousands,
   * and the caller only ever renders a page of them. `groupScreensByTurn` is
   * order-independent (it sorts by `createdAt` then `step` itself), so feeding
   * it a DESC page is equivalent to feeding it an ASC one, and it is the same
   * function the memory store uses: turn order is never derived per backend.
   * The final slice trims the group pass back to `limit`.
   *
   * `screen_id` (an insertion-ordered BIGSERIAL) is a required third sort key,
   * not cosmetic: two different turns' first screens can share one
   * `created_at` — PGlite's clock is millisecond-resolution, so two awaited
   * inserts issued back to back (no network round trip between them) land in
   * the same millisecond far more often than over a real Postgres connection.
   * Without a tiebreaker, Postgres' sort is free to return that tied pair in
   * either order, which `groupScreensByTurn`'s *stable* sort then preserves
   * as whichever turn "started first" — flipping the result between runs.
   * `screen_id ASC` breaks the tie the same way the memory store always has:
   * by true insertion order.
   */
  async listScreens(
    channelUrl: string,
    opts: { turnId?: string; limit?: number } = {},
  ): Promise<Screen[]> {
    const limit = opts.limit ?? 200
    const params: unknown[] = [channelUrl, this.workspaceId]
    let query = `SELECT * FROM screens WHERE channel_url = $1 AND ${IN_WORKSPACE}`
    if (opts.turnId) {
      params.push(opts.turnId)
      query += ` AND turn_id = $${params.length}`
    }
    params.push(limit)
    query += ` ORDER BY created_at DESC, step ASC, screen_id ASC LIMIT $${params.length}`

    const { rows } = await this.db.query<ScreenRow>(query, params)
    return groupScreensByTurn(rows.map(rowToScreen)).slice(0, limit)
  }

  async getScreenImagePath(
    channelUrl: string,
    screenId: number,
    opts: { attachedOnly?: boolean } = {},
  ): Promise<string | null> {
    const { rows } = await this.db.query<{ image_path: string | null }>(
      `SELECT image_path FROM screens WHERE channel_url = $1 AND ${IN_WORKSPACE} AND screen_id = $3${
        opts.attachedOnly ? ' AND message_id IS NOT NULL' : ''
      }`,
      [channelUrl, this.workspaceId, screenId],
    )
    return rows[0]?.image_path ?? null
  }

  async attachScreensToMessage(channelUrl: string, turnId: string, messageId: number): Promise<void> {
    await this.db.query(
      `UPDATE screens SET message_id = $4 WHERE channel_url = $1 AND ${IN_WORKSPACE} AND turn_id = $3`,
      [channelUrl, this.workspaceId, turnId, messageId],
    )
  }

  async listSkills(): Promise<Skill[]> {
    const { rows } = await this.db.query<{
      skill_id: string
      name: string
      description: string
      body: string
      file_name: string
      created_at: Date
    }>(
      'SELECT skill_id, name, description, body, file_name, created_at FROM skills WHERE workspace_id = $1 ORDER BY created_at DESC',
      [this.workspaceId],
    )
    return rows.map((row) => ({
      id: row.skill_id,
      name: row.name,
      description: row.description,
      body: row.body,
      fileName: row.file_name,
      uploadedAt: new Date(row.created_at).getTime(),
    }))
  }

  async listSkillIds(): Promise<string[]> {
    const { rows } = await this.db.query<{ skill_id: string }>(
      'SELECT skill_id FROM skills WHERE workspace_id = $1 ORDER BY skill_id',
      [this.workspaceId],
    )
    return rows.map((row) => row.skill_id)
  }

  async createSkill(input: CreateSkillInput): Promise<Skill> {
    const parsed = parseSkillMarkdown(input.fileName, input.content)
    try {
      assertUsableSkill(parsed)
    } catch (error) {
      throw InvalidSkill(error instanceof Error ? error.message : 'Invalid skill file')
    }

    const skill: Skill = {
      id: `skill_${randomBytes(6).toString('hex')}`,
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      fileName: input.fileName,
      uploadedAt: Date.now(),
    }

    await this.db.query(
      `INSERT INTO skills (skill_id, name, description, body, file_name, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [skill.id, skill.name, skill.description, skill.body, skill.fileName, this.workspaceId],
    )

    return skill
  }

  async deleteSkill(skillId: string): Promise<void> {
    // ON DELETE CASCADE drops the skill's chunks with it.
    const { rowCount } = await this.db.query('DELETE FROM skills WHERE skill_id = $1 AND workspace_id = $2', [
      skillId,
      this.workspaceId,
    ])
    if (!rowCount) throw SkillNotFound(skillId)
  }

  async claimLocalData(userId: string): Promise<'claimed' | 'already'> {
    return this.db.transaction(async (tx) => {
      // Two first sign-ins at once: the second waits here, then finds the row.
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('opendots_claim'))")
      const { rows } = await tx.query(
        "INSERT INTO instance_claims (name, value) VALUES ('local_data', $1) ON CONFLICT (name) DO NOTHING RETURNING name",
        [userId],
      )
      if (rows.length === 0) return 'already'
      // They were the local person: what that person had read, they have read.
      await tx.query(
        `INSERT INTO read_receipts (channel_url, user_id, read_at)
         SELECT r.channel_url, $1, r.read_at
           FROM read_receipts r JOIN channels c ON c.channel_url = r.channel_url
          WHERE c.workspace_id = $2 AND r.user_id = $3
         ON CONFLICT (channel_url, user_id) DO UPDATE SET read_at = GREATEST(read_receipts.read_at, EXCLUDED.read_at)`,
        [userId, LOCAL_SCOPE.workspaceId, LOCAL_SCOPE.actor.userId],
      )
      // And what they sent is theirs.
      await tx.query(
        `UPDATE messages SET sender_id = $1
          WHERE sender_id = $3 AND channel_url IN (SELECT channel_url FROM channels WHERE workspace_id = $2)`,
        [userId, LOCAL_SCOPE.workspaceId, LOCAL_SCOPE.actor.userId],
      )
      await tx.query('UPDATE channels SET workspace_id = $1 WHERE workspace_id = $2', [userId, LOCAL_SCOPE.workspaceId])
      await tx.query('UPDATE skills SET workspace_id = $1 WHERE workspace_id = $2', [userId, LOCAL_SCOPE.workspaceId])
      return 'claimed'
    })
  }
}
