import type { ChatRepository } from './chat-repository'
import { memoryRepository } from './memory-store'
import { PostgresChatRepository } from './postgres-store'

/**
 * Chooses the store from the environment.
 *
 * Every route depends on this rather than on a concrete store, so switching the
 * whole app to Postgres is `DATA_STORE=postgres` and nothing else. Keeping the
 * memory store as the default means the app, the golden set, and `pnpm dev` all
 * still work with no infrastructure running.
 */

let cached: ChatRepository | undefined

export function getRepository(): ChatRepository {
  cached ??=
    process.env.DATA_STORE === 'postgres' ? new PostgresChatRepository() : memoryRepository
  return cached
}

export function describeStore(): { kind: string } {
  return { kind: process.env.DATA_STORE === 'postgres' ? 'postgres' : 'memory' }
}
