import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatRepository } from '../../repository/chat-repository'
import { memoryRepository } from '../../repository/memory-store'
import { getAiConfig } from '../config'
import { getRetriever } from './retriever'

/**
 * A `ChatRepository` where only the given methods actually work; every other
 * member throws if called. Pins the contract that `getRetriever` reads
 * skills through the repository interface (`listSkills` / `listSkillIds`)
 * and nothing else — a test fails loudly the moment it reaches further.
 */
function fakeRepository(overrides: Partial<ChatRepository>): ChatRepository {
  return new Proxy({} as ChatRepository, {
    get(_target, prop) {
      if (typeof prop === 'string' && prop in overrides) {
        return overrides[prop as keyof ChatRepository]
      }
      return () => {
        throw new Error(`ChatRepository.${String(prop)} is not implemented in this fake`)
      }
    },
  })
}

test('getRetriever reads skills through the injected repository, not the memory store', async () => {
  const skill = {
    id: 'skill_fake_1',
    name: 'Reimbursement policy',
    description: 'How reimbursements are tracked',
    body: 'The quarterly reimbursement ledger records every approved expense and who signed off on it.',
    fileName: 'reimbursement.md',
    uploadedAt: Date.now(),
  }
  const repo = fakeRepository({
    listSkills: async () => [skill],
    listSkillIds: async () => [skill.id],
  })

  const retriever = await getRetriever(getAiConfig(), repo)
  const results = await retriever.retrieve('reimbursement ledger')

  assert.ok(
    results.some((r) => r.source === `skill/${skill.fileName}`),
    `expected a chunk sourced from skill/${skill.fileName}, got: ${results.map((r) => r.source).join(', ') || '(none)'}`,
  )
})

test('getRetriever finds an uploaded skill via the memory repository, and forgets it once deleted', async () => {
  const created = await memoryRepository.createSkill({
    fileName: 'retriever-cache-check.md',
    content: 'The nocturnal warehouse inventory reconciliation happens every Tuesday at midnight.',
  })

  const before = await getRetriever(getAiConfig(), memoryRepository)
  const foundBefore = await before.retrieve('warehouse inventory reconciliation')
  assert.ok(
    foundBefore.some((r) => r.source === `skill/${created.fileName}`),
    'expected the freshly uploaded skill to be retrievable',
  )

  await memoryRepository.deleteSkill(created.id)

  // No TTL to wait out: the id check runs on every call, so deletion is
  // visible on the very next getRetriever() call.
  const after = await getRetriever(getAiConfig(), memoryRepository)
  const foundAfter = await after.retrieve('warehouse inventory reconciliation')
  assert.ok(
    !foundAfter.some((r) => r.source === `skill/${created.fileName}`),
    'expected the deleted skill to no longer be retrievable',
  )
})
