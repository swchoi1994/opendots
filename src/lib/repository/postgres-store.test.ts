import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openPglite, pgliteDb, type Db } from '../db'
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

repositoryContract('pglite', async () => (await store()).repo)

test('pglite: a session row written before 004 (no provider) reads back with provider null', async () => {
  const { db, repo } = await store()
  const channel = await repo.createChannel({ name: 'Legacy Session', assistant: (await repo.listChannels())[0]!.assistant! })
  await db.query('INSERT INTO bot_sessions (channel_url, session_id) VALUES ($1, $2)', [channel.channelUrl, 'old-sess'])
  assert.deepEqual(await repo.getBotSession(channel.channelUrl), { sessionId: 'old-sess', provider: null })
})
