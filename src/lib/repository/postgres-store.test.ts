import { openPglite, pgliteDb } from '../db'
import { migrate } from '../migrate'
import { repositoryContract } from './contract'
import { PostgresChatRepository } from './postgres-store'

/** One in-memory PGlite for the whole contract, mirroring the memory store's single shared instance. */
let repo: PostgresChatRepository | undefined

repositoryContract('pglite', async () => {
  if (!repo) {
    const db = pgliteDb(await openPglite())
    await migrate(db)
    repo = new PostgresChatRepository(db)
  }
  return repo
})
