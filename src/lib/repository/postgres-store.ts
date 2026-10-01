import { randomBytes } from 'node:crypto'
import { removeWorkspace } from '../bots/workspace'
import { parseAssistantConfig, type AssistantConfig } from '../domain/assistant'
import { ROSTER } from '../domain/roster'
import { groupScreensByTurn, screenImageUrl, type NewScreen, type Screen } from '../domain/screen'
import { assistantUser, channelUrlFor, me, rosterAssistant } from '../domain/seed'
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
import { getDb, type Db } from '../db'
import {
  ChannelFrozen,
  ChannelNotFound,
  EmptyChannelName,
  EmptyMessage,
  InvalidSkill,
  SkillNotFound,
  type ChatRepository,
  type CreateChannelInput,
  type CreateSkillInput,
  type Deployment,
} from './chat-repository'

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
 */

/** Assistant channels have exactly these two members; only they post here. */
function userFor(senderId: string, senderName: string, bot: User | null): User {
  if (senderId === me.userId) return me
  if (bot && senderId === bot.userId) return bot
  if (senderId === assistantUser.userId) return { ...assistantUser, nickname: bot?.nickname ?? senderName }
  return { userId: senderId, nickname: senderName, colorToken: 'violet' }
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

function rowToSummary(row: ChannelRow): ChannelSummary {
  const assistant = row.assistant ? parseAssistantConfig(row.assistant, row.name) : null
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
    members: bot ? [me, bot] : [me],
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

// Selects each channel with its last message (LATERAL) and the current user's
// unread count in one round trip.
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
`

export class PostgresChatRepository implements ChatRepository {
  private seeded = false

  /** Tests inject an in-memory PGlite; the app uses the process-wide database (PGlite or a server). */
  constructor(private readonly injected?: Db) {}

  private get db(): Db {
    return this.injected ?? getDb()
  }

  private async requireChannel(channelUrl: string): Promise<{ isFrozen: boolean }> {
    const { rows } = await this.db.query<{ is_frozen: boolean }>(
      'SELECT is_frozen FROM channels WHERE channel_url = $1',
      [channelUrl],
    )
    if (rows.length === 0) throw ChannelNotFound(channelUrl)
    return { isFrozen: rows[0]!.is_frozen }
  }

  /**
   * Seeds the nine-bot roster on first use against an empty database, so a
   * fresh `docker compose up` (or a wiped table) gets the same starting point
   * as the in-memory store without a separate seed script.
   */
  private async seedIfEmpty(): Promise<void> {
    if (this.seeded || process.env.SEED_BOTS === '0') return

    await this.db.transaction(async (tx) => {
      // Advisory lock scoped to this transaction: a second concurrent seeder
      // (another request, or another instance on the same server) blocks here
      // until this one commits, so "check empty, then insert" cannot interleave.
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('opendots_seed'))")

      const { rows } = await tx.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM channels')
      if (Number(rows[0]?.n ?? '0') > 0) return

      for (const entry of ROSTER) {
        const channelUrl = channelUrlFor(entry.slug)
        const assistant = rosterAssistant(entry)
        const bot = botUserFor(channelUrl, assistant)
        await tx.query(
          `INSERT INTO channels (channel_url, name, member_count, is_frozen, assistant)
           VALUES ($1, $2, 2, FALSE, $3) ON CONFLICT (channel_url) DO NOTHING`,
          [channelUrl, entry.name, JSON.stringify(assistant)],
        )
        await tx.query(
          `INSERT INTO messages (channel_url, sender_id, sender_name, body, message_type)
           VALUES ($1, $2, $3, $4, 'user')`,
          [channelUrl, bot.userId, bot.nickname, entry.intro],
        )
        await tx.query(
          `INSERT INTO read_receipts (channel_url, user_id, read_at) VALUES ($1, $2, NOW()), ($1, $3, NOW())
           ON CONFLICT (channel_url, user_id) DO UPDATE SET read_at = EXCLUDED.read_at`,
          [channelUrl, me.userId, bot.userId],
        )
      }
    })
    this.seeded = true
  }

  async listChannels(): Promise<ChannelSummary[]> {
    await this.seedIfEmpty()
    const { rows } = await this.db.query<ChannelRow>(
      `${CHANNEL_SELECT} ORDER BY COALESCE(m.created_at, c.created_at) DESC`,
      [me.userId],
    )
    return rows.map(rowToSummary)
  }

  async getChannel(channelUrl: string): Promise<ChannelSummary | null> {
    const { rows } = await this.db.query<ChannelRow>(
      `${CHANNEL_SELECT} WHERE c.channel_url = $2`,
      [me.userId, channelUrl],
    )
    return rows[0] ? rowToSummary(rows[0]) : null
  }

  async listMessages(channelUrl: string): Promise<MessageWithReceipt[] | null> {
    // Null (no channel) vs [] (channel, no messages) — the routes map that to 404 vs 200.
    const exists = await this.db.query('SELECT 1 FROM channels WHERE channel_url = $1', [channelUrl])
    if (exists.rows.length === 0) return null

    const channel = await this.getChannel(channelUrl)
    const bot = channel?.assistant ? botUserFor(channelUrl, channel.assistant) : null
    const members = bot ? [me, bot] : [me]

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
      [channelUrl, me.userId, me.nickname, trimmed],
    )
    const message = rowToMessage(rows[0]!, null)
    // Sending is an implicit read of everything up to it.
    await this.setReadReceipt(channelUrl, me.userId)
    return message
  }

  async appendAssistantMessage(
    channelUrl: string,
    text: string,
    provenance?: MessageProvenance,
  ): Promise<Message> {
    const channel = await this.getChannel(channelUrl)
    if (!channel) throw ChannelNotFound(channelUrl)
    const bot = channel.assistant ? botUserFor(channelUrl, channel.assistant) : me
    const { rows } = await this.db.query<MessageRow>(
      `INSERT INTO messages (channel_url, sender_id, sender_name, body, message_type, provenance)
       VALUES ($1, $2, $3, $4, 'user', $5)
       RETURNING message_id, channel_url, sender_id, sender_name, body, provenance, created_at`,
      [channelUrl, bot.userId, bot.nickname, text, provenance ? JSON.stringify(provenance) : null],
    )
    const message = rowToMessage(rows[0]!, bot)
    // The user is looking at the conversation they just posted into, so the
    // reply should not arrive already marked unread; and the bot has
    // "read" up to its own reply, so the user's messages show the double check.
    await Promise.all([
      this.setReadReceipt(channelUrl, me.userId),
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
    await this.setReadReceipt(channelUrl, me.userId)
    return (await this.getChannel(channelUrl))!
  }

  async createChannel(input: CreateChannelInput): Promise<ChannelSummary> {
    const name = input.name.trim()
    if (!name) throw EmptyChannelName()

    const channelUrl = `channel_assistant_${randomBytes(6).toString('hex')}`
    await this.db.query(
      `INSERT INTO channels (channel_url, name, member_count, is_frozen, assistant)
       VALUES ($1, $2, 2, FALSE, $3)`,
      [channelUrl, name, JSON.stringify(input.assistant)],
    )
    await this.setReadReceipt(channelUrl, me.userId)
    return (await this.getChannel(channelUrl))!
  }

  async updateAssistant(channelUrl: string, assistant: AssistantConfig): Promise<ChannelSummary> {
    // The name travels with the config: the channel name is what the sidebar
    // renders, so updating only the JSON made a rename half-apply.
    const { rowCount } = await this.db.query(
      'UPDATE channels SET assistant = $2, name = $3 WHERE channel_url = $1',
      [channelUrl, JSON.stringify(assistant), assistant.name],
    )
    if (!rowCount) throw ChannelNotFound(channelUrl)
    return (await this.getChannel(channelUrl))!
  }

  async deleteChannel(channelUrl: string): Promise<void> {
    // ON DELETE CASCADE removes the channel's messages, receipts, deployment and bot session.
    const { rowCount } = await this.db.query('DELETE FROM channels WHERE channel_url = $1', [channelUrl])
    if (!rowCount) throw ChannelNotFound(channelUrl)
    removeWorkspace(channelUrl)
    // Deleting can empty the table, and `seeded` is what stops the lazy roster
    // seed from ever looking again. Leave it latched and a wiped database stays
    // empty for the life of the process.
    this.seeded = false
  }

  async deleteAllChannels(): Promise<number> {
    const { rows } = await this.db.query<{ channel_url: string }>('SELECT channel_url FROM channels')
    for (const r of rows) removeWorkspace(r.channel_url)
    const { rowCount } = await this.db.query('DELETE FROM channels')
    // The table is now empty by construction: the next request must be allowed
    // to re-seed the roster.
    this.seeded = false
    return rowCount ?? 0
  }

  async deployChannel(channelUrl: string): Promise<Deployment> {
    await this.requireChannel(channelUrl)

    const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
    const passcode = Array.from(randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join('')
    const id = randomBytes(8).toString('hex')

    // Deploying twice must return the SAME id — the no-op UPDATE returns the
    // existing row rather than minting a new one (unique index on channel_url).
    const { rows } = await this.db.query<{
      deployment_id: string
      channel_url: string
      passcode: string
      allow_posting: boolean
      created_at: Date
    }>(
      `INSERT INTO deployments (deployment_id, channel_url, passcode, allow_posting)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (channel_url) DO UPDATE SET channel_url = EXCLUDED.channel_url
       RETURNING deployment_id, channel_url, passcode, allow_posting, created_at`,
      [id, channelUrl, passcode],
    )
    const row = rows[0]!
    return {
      id: row.deployment_id,
      channelUrl: row.channel_url,
      createdAt: new Date(row.created_at).getTime(),
      passcode: row.passcode,
      allowPosting: row.allow_posting,
    }
  }

  async getDeployment(deploymentId: string): Promise<Deployment | null> {
    const { rows } = await this.db.query<{
      deployment_id: string
      channel_url: string
      passcode: string
      allow_posting: boolean
      created_at: Date
    }>(
      'SELECT deployment_id, channel_url, passcode, allow_posting, created_at FROM deployments WHERE deployment_id = $1',
      [deploymentId],
    )
    const row = rows[0]
    if (!row) return null
    return {
      id: row.deployment_id,
      channelUrl: row.channel_url,
      createdAt: new Date(row.created_at).getTime(),
      passcode: row.passcode,
      allowPosting: row.allow_posting,
    }
  }

  async getBotSession(channelUrl: string): Promise<string | null> {
    const { rows } = await this.db.query<{ session_id: string }>(
      'SELECT session_id FROM bot_sessions WHERE channel_url = $1',
      [channelUrl],
    )
    return rows[0]?.session_id ?? null
  }

  async setBotSession(channelUrl: string, sessionId: string): Promise<void> {
    await this.requireChannel(channelUrl)
    await this.db.query(
      `INSERT INTO bot_sessions (channel_url, session_id, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (channel_url) DO UPDATE SET session_id = EXCLUDED.session_id, updated_at = NOW()`,
      [channelUrl, sessionId],
    )
  }

  async clearBotSession(channelUrl: string): Promise<void> {
    await this.db.query('DELETE FROM bot_sessions WHERE channel_url = $1', [channelUrl])
  }

  async appendScreen(input: NewScreen): Promise<Screen> {
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
    const params: unknown[] = [channelUrl]
    let query = 'SELECT * FROM screens WHERE channel_url = $1'
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
      `SELECT image_path FROM screens WHERE channel_url = $1 AND screen_id = $2${
        opts.attachedOnly ? ' AND message_id IS NOT NULL' : ''
      }`,
      [channelUrl, screenId],
    )
    return rows[0]?.image_path ?? null
  }

  async attachScreensToMessage(channelUrl: string, turnId: string, messageId: number): Promise<void> {
    await this.db.query(
      'UPDATE screens SET message_id = $3 WHERE channel_url = $1 AND turn_id = $2',
      [channelUrl, turnId, messageId],
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
    }>('SELECT skill_id, name, description, body, file_name, created_at FROM skills ORDER BY created_at DESC')
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
      'SELECT skill_id FROM skills ORDER BY skill_id',
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
      `INSERT INTO skills (skill_id, name, description, body, file_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [skill.id, skill.name, skill.description, skill.body, skill.fileName],
    )

    return skill
  }

  async deleteSkill(skillId: string): Promise<void> {
    // ON DELETE CASCADE drops the skill's chunks with it.
    const { rowCount } = await this.db.query('DELETE FROM skills WHERE skill_id = $1', [skillId])
    if (!rowCount) throw SkillNotFound(skillId)
  }
}
