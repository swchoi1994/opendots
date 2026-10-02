import { storeKind, type StoreKind } from '../db'
import { LOCAL_SCOPE, type ChatRepository, type Scope } from './chat-repository'
import { createMemoryRepository, memoryRepository } from './memory-store'
import { PostgresChatRepository } from './postgres-store'

/**
 * Chooses the store from DATA_STORE: the embedded PGlite database by default,
 * a Postgres server with DATA_STORE=postgres, and the in-memory store for
 * tests and the eval. Routes depend on this, never on a concrete store.
 *
 * A repository is bound to a scope, the workspace and the person acting, so
 * routes build one per request: `getRepository(scopeFor(viewer))`. With no
 * scope it is the local workspace's, which is what local mode, the eval and
 * the deployment lookup use. Instances are cheap: the data lives in the store.
 */

let local: ChatRepository | undefined

export function getRepository(scope: Scope = LOCAL_SCOPE): ChatRepository {
  if (scope === LOCAL_SCOPE) {
    local ??= storeKind() === 'memory' ? memoryRepository : new PostgresChatRepository()
    return local
  }
  return storeKind() === 'memory' ? createMemoryRepository(scope) : new PostgresChatRepository(undefined, scope)
}

export function describeStore(): { kind: StoreKind } {
  return { kind: storeKind() }
}
