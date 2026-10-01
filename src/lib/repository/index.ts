import { storeKind, type StoreKind } from '../db'
import type { ChatRepository } from './chat-repository'
import { memoryRepository } from './memory-store'
import { PostgresChatRepository } from './postgres-store'

/**
 * Chooses the store from DATA_STORE: the embedded PGlite database by default,
 * a Postgres server with DATA_STORE=postgres, and the in-memory store for
 * tests and the eval. Routes depend on this, never on a concrete store.
 */

let cached: ChatRepository | undefined

export function getRepository(): ChatRepository {
  cached ??= storeKind() === 'memory' ? memoryRepository : new PostgresChatRepository()
  return cached
}

export function describeStore(): { kind: StoreKind } {
  return { kind: storeKind() }
}
