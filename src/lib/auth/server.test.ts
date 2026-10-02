import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Unauthenticated, getViewer, requireViewer, setAuthSourceForTests } from './server'
import { LOCAL_VIEWER } from './viewer'

const CLERK = { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_x', CLERK_SECRET_KEY: 'sk_test_x' }

afterEach(() => setAuthSourceForTests(null))

test('local mode is always the local viewer, and Clerk is never asked', async () => {
  let asked = 0
  setAuthSourceForTests(async () => {
    asked += 1
    return { userId: 'user_x', orgId: null, isOrgAdmin: false, claims: null }
  })
  assert.deepEqual(await getViewer({}), LOCAL_VIEWER)
  assert.equal(asked, 0)
})

test('Clerk mode maps the session to a viewer', async () => {
  setAuthSourceForTests(async () => ({ userId: 'user_b', orgId: 'org_t', isOrgAdmin: false, claims: { name: 'Bob' } }))
  assert.deepEqual(await getViewer(CLERK), {
    userId: 'user_b', name: 'Bob', imageUrl: null, workspaceId: 'org_t', role: 'member',
  })
})

test('Clerk mode with nobody signed in has no viewer, and requiring one is a 401', async () => {
  setAuthSourceForTests(async () => ({ userId: null, orgId: null, isOrgAdmin: false, claims: null }))
  assert.equal(await getViewer(CLERK), null)
  await assert.rejects(requireViewer(CLERK), (error: unknown) => {
    return error instanceof Unauthenticated && error.status === 401 && error.code === 'UNAUTHENTICATED'
  })
})

test('a claim that fails is tried again on the next personal sign-in, not remembered', async () => {
  const { memoryRepository } = await import('../repository/memory-store')
  const original = memoryRepository.claimLocalData
  let attempts = 0
  memoryRepository.claimLocalData = async () => {
    attempts += 1
    throw new Error('store unavailable')
  }
  try {
    setAuthSourceForTests(async () => ({ userId: 'user_z', orgId: null, isOrgAdmin: false, claims: null }))
    await assert.rejects(getViewer(CLERK), /store unavailable/)
    await assert.rejects(getViewer(CLERK), /store unavailable/)
    assert.equal(attempts, 2)
  } finally {
    memoryRepository.claimLocalData = original
  }
})

test('the first personal sign-in claims the local bots; a team viewer never does, and nobody claims twice', async () => {
  const { createMemoryRepository, memoryRepository } = await import('../repository/memory-store')
  const localUrl = (await memoryRepository.listChannels())[0]!.channelUrl
  const home = (userId: string) => createMemoryRepository({ workspaceId: userId, actor: { userId, name: userId } })

  setAuthSourceForTests(async () => ({ userId: 'user_t', orgId: 'org_t', isOrgAdmin: true, claims: null }))
  await getViewer(CLERK)
  assert.ok(await memoryRepository.getChannel(localUrl), 'a team viewer leaves local data alone')

  setAuthSourceForTests(async () => ({ userId: 'user_a', orgId: null, isOrgAdmin: false, claims: null }))
  await getViewer(CLERK)
  assert.equal(await memoryRepository.getChannel(localUrl), null)
  assert.ok(await home('user_a').getChannel(localUrl), 'the local bots are now in their personal workspace')

  setAuthSourceForTests(async () => ({ userId: 'user_b', orgId: null, isOrgAdmin: false, claims: null }))
  await getViewer(CLERK)
  assert.ok(await home('user_a').getChannel(localUrl), 'a second personal sign-in takes nothing')
  assert.equal(await home('user_b').getChannel(localUrl), null)
})
