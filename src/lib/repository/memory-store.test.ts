import { repositoryContract } from './contract'
import { memoryRepository } from './memory-store'

repositoryContract('memory', async () => memoryRepository)
