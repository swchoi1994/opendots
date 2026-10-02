import { LOCAL_SCOPE } from './chat-repository'
import { repositoryContract } from './contract'
import { createMemoryRepository } from './memory-store'

repositoryContract('memory', async (scope) => createMemoryRepository(scope ?? LOCAL_SCOPE))
