import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openPglite, pgliteDb, type Db } from '../db'
import { DEFAULT_ASSISTANT } from '../domain/assistant'
import { migrate } from '../migrate'
import { repositoryContract } from './contract'
import { PostgresChatRepository } from './postgres-store'

/** One in-memory PGlite for the whole contract, mirroring the memory store's single shared instance. */
let shared: { db: Db; repo: PostgresChatRepository } | undefined

async function store(): Promise<{ db: Db; repo: PostgresChatRepository }> {
  if (!shared) {
    const db = pgliteDb(await openPglite())
    await migrate(db)
    shared = { db, repo: new PostgresChatRepository(db) }
  }
  return shared
}

repositoryContract('pglite', async (scope) => new PostgresChatRepository((await store()).db, scope))

test('pglite: a session row written before 004 (no provider) reads back with provider null', async () => {
  const { db, repo } = await store()
  // Its own bot: the contract's last test leaves the local workspace claimed and empty.
  const channel = await repo.createChannel({ name: 'Legacy Session', assistant: DEFAULT_ASSISTANT })
  await db.query('INSERT INTO bot_sessions (channel_url, session_id) VALUES ($1, $2)', [channel.channelUrl, 'old-sess'])
  assert.deepEqual(await repo.getBotSession(channel.channelUrl), { sessionId: 'old-sess', provider: null })
})

test('pglite: after a claim, a restarted process lists an empty local workspace instead of colliding with the claimed urls', async () => {
  const pg = await openPglite()
  const first = pgliteDb(pg)
  await migrate(first)
  const seeded = await new PostgresChatRepository(first).listChannels()
  assert.equal(await new PostgresChatRepository(first).claimLocalData({ userId: 'user_claimant', name: 'Claimant' }), 'claimed')

  // A new Db handle over the same data has no seeding memory: a restarted process.
  const restarted = pgliteDb(pg)
  assert.deepEqual(await new PostgresChatRepository(restarted).listChannels(), [])
  const claimant = new PostgresChatRepository(restarted, { workspaceId: 'user_claimant', actor: { userId: 'user_claimant', name: 'Claimant' } })
  const theirs = await claimant.listChannels()
  assert.deepEqual(theirs.map((c) => c.channelUrl).sort(), seeded.map((c) => c.channelUrl).sort())
  for (const { channelUrl } of theirs) {
    assert.equal((await claimant.listMessages(channelUrl))!.length, 1, `${channelUrl} keeps exactly its own intro`)
  }
  await pg.close()
})

test('pglite: a stored bot with no tool list reads as having no host-reaching tools', async () => {
  const { db, repo } = await store()
  const channel = await repo.createChannel({ name: 'Legacy Tools', assistant: DEFAULT_ASSISTANT })
  const { tools: _dropped, ...legacy } = DEFAULT_ASSISTANT
  await db.query('UPDATE channels SET assistant = $2 WHERE channel_url = $1', [channel.channelUrl, JSON.stringify(legacy)])
  const tools = (await repo.getChannel(channel.channelUrl))!.assistant!.tools
  assert.deepEqual(tools.filter((tool) => ['files', 'shell', 'skills', 'web_browser'].includes(tool)), [])
  assert.ok(tools.includes('rag_search'), 'the harmless defaults remain')
})
