import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatRepository } from '../../repository/chat-repository'
import { createMemoryRepository, memoryRepository } from '../../repository/memory-store'
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
    scope: { workspaceId: 'ws_fake', actor: { userId: 'user_fake', name: 'Fake' } },
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

test("knowledge search in one workspace never finds another workspace's document", async () => {
  const alpha = createMemoryRepository({ workspaceId: 'org_alpha', actor: { userId: 'user_a', name: 'A' } })
  const beta = createMemoryRepository({ workspaceId: 'org_beta', actor: { userId: 'user_b', name: 'B' } })
  const created = await alpha.createSkill({
    fileName: 'alpha-secret.md',
    content: 'The alpha team rotates the zeppelin hangar keys every fortnight.',
  })
  const fromAlpha = await (await getRetriever(getAiConfig(), alpha)).retrieve('zeppelin hangar keys')
  const fromBeta = await (await getRetriever(getAiConfig(), beta)).retrieve('zeppelin hangar keys')
  assert.ok(fromAlpha.some((r) => r.source === `skill/${created.fileName}`))
  assert.ok(!fromBeta.some((r) => r.source === `skill/${created.fileName}`))
})

test('a document uploaded and deleted between the id check and the index build never stays searchable', async () => {
  const doc = (id: string, body: string) => ({ id, name: id, description: id, body, fileName: `${id}.md`, uploadedAt: 0 })
  let ids = ['race_a']
  let docs = [doc('race_a', 'The nightly ledger closes at nine.'), doc('race_b', 'The quartz turbine hums in hangar seven.')]
  const repo = fakeRepository({
    scope: { workspaceId: 'ws_race', actor: { userId: 'user_r', name: 'R' } },
    listSkillIds: async () => ids,
    listSkills: async () => docs,
  })
  // First call: race_b arrives after the ids were read, so it is indexed.
  await getRetriever(getAiConfig(), repo)
  // It is deleted again; the ids now look exactly like the first read did.
  docs = [doc('race_a', 'The nightly ledger closes at nine.')]
  ids = ['race_a']
  const after = await (await getRetriever(getAiConfig(), repo)).retrieve('quartz turbine hangar')
  assert.ok(!after.some((r) => r.source === 'skill/race_b.md'), 'the deleted document must not be served from a stale index')
})
