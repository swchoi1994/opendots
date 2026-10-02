import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  LOCAL_VIEWER,
  assertToolChange,
  authMode,
  canToggleTool,
  isHostTool,
  viewerFromAuth,
  type Viewer,
} from './viewer'

const KEYS = { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_x', CLERK_SECRET_KEY: 'sk_test_x' }

test('Clerk mode needs both keys; anything less is local mode', () => {
  assert.equal(authMode({}), 'local')
  assert.equal(authMode({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_x' }), 'local')
  assert.equal(authMode({ CLERK_SECRET_KEY: 'sk_test_x' }), 'local')
  assert.equal(authMode({ ...KEYS, CLERK_SECRET_KEY: '' }), 'local')
  assert.equal(authMode(KEYS), 'clerk')
})

test('no signed-in user means no viewer', () => {
  assert.equal(viewerFromAuth({ userId: null, orgId: null, isOrgAdmin: false, claims: null }), null)
})

test('without an active organization the viewer is in their personal workspace, as its admin', () => {
  assert.deepEqual(
    viewerFromAuth({ userId: 'user_a', orgId: null, isOrgAdmin: false, claims: { name: 'Ada Lovelace', image: 'https://img/a.png' } }),
    { userId: 'user_a', name: 'Ada Lovelace', imageUrl: 'https://img/a.png', workspaceId: 'user_a', role: 'admin' },
  )
})

test('in an organization the role follows org:admin', () => {
  const admin = viewerFromAuth({ userId: 'user_a', orgId: 'org_t', isOrgAdmin: true, claims: { name: 'Ada' } })
  assert.equal(admin?.workspaceId, 'org_t')
  assert.equal(admin?.role, 'admin')
  const member = viewerFromAuth({ userId: 'user_b', orgId: 'org_t', isOrgAdmin: false, claims: { name: 'Bob' } })
  assert.equal(member?.workspaceId, 'org_t')
  assert.equal(member?.role, 'member')
})

test('the name falls back to the email address, then to a neutral label; junk claims are ignored', () => {
  // Clerk renders {{user.full_name}} as "" for a user who never set a name.
  const noName = viewerFromAuth({ userId: 'user_a', orgId: null, isOrgAdmin: false, claims: { name: '  ', email: 'ada@example.com', image: '' } })
  assert.equal(noName?.name, 'ada')
  assert.equal(noName?.imageUrl, null)
  const nothing = viewerFromAuth({ userId: 'user_a', orgId: null, isOrgAdmin: false, claims: { name: 42, email: null } })
  assert.equal(nothing?.name, 'Someone')
  assert.equal(viewerFromAuth({ userId: 'user_a', orgId: null, isOrgAdmin: false, claims: null })?.name, 'Someone')
})

test('host-reaching tools are the ones that touch the server machine', () => {
  assert.deepEqual(
    (['rag_search', 'channel_history', 'files', 'shell', 'skills', 'web_browser'] as const).filter(isHostTool),
    ['files', 'shell', 'skills', 'web_browser'],
  )
})

const member: Viewer = { ...LOCAL_VIEWER, userId: 'user_b', workspaceId: 'org_t', role: 'member' }

test('members cannot add a host-reaching tool; they can remove one and add the rest', () => {
  assert.doesNotThrow(() => assertToolChange(LOCAL_VIEWER, [], ['shell', 'web_browser']), 'an admin may grant anything')
  assert.throws(() => assertToolChange(member, ['rag_search'], ['rag_search', 'shell']), (error: unknown) => {
    const e = error as { status?: number; code?: string; message?: string }
    return e.status === 403 && e.code === 'ADMIN_ONLY' && /shell/.test(e.message ?? '')
  })
  assert.throws(() => assertToolChange(member, [], ['files']), /admins/, 'a new bot counts as adding every tool it starts with')
  assert.doesNotThrow(() => assertToolChange(member, ['shell', 'files'], ['files']), 'removing is always allowed')
  assert.doesNotThrow(() => assertToolChange(member, ['shell'], ['shell', 'rag_search']), 'keeping a granted tool is not adding it')
})

test('the UI lets a member switch a host-reaching tool off, but never on', () => {
  assert.equal(canToggleTool('admin', 'shell', false), true)
  assert.equal(canToggleTool('member', 'rag_search', false), true)
  assert.equal(canToggleTool('member', 'shell', false), false)
  assert.equal(canToggleTool('member', 'shell', true), true)
})
