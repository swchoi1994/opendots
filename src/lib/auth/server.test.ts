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
