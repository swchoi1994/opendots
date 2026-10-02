import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import { setAuthSourceForTests } from '@/lib/auth/server'
import type { AuthFacts } from '@/lib/auth/viewer'
import { DEFAULT_ASSISTANT, type ToolName } from '@/lib/domain/assistant'
import * as channel from './channels/[channelUrl]/route'
import * as browser from './channels/[channelUrl]/browser/route'
import * as deploy from './channels/[channelUrl]/deploy/route'
import * as messages from './channels/[channelUrl]/messages/route'
import * as channels from './channels/route'
import * as unlock from './deployments/[deploymentId]/unlock/route'
import * as health from './health/route'
import * as models from './models/route'
import * as ragSearch from './rag/search/route'
import * as skill from './skills/[skillId]/route'
import * as skills from './skills/route'

/**
 * The routes in Clerk mode, with Clerk replaced by a fake session. What they
 * promise: nobody signed in gets a 401, each viewer works in their own
 * workspace as themselves, and members can't grant host tools or delete.
 */

const KEYS = { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_routes', CLERK_SECRET_KEY: 'sk_test_routes', OPENDOTS_OPERATORS: 'user_ada' }
before(() => Object.assign(process.env, KEYS))
after(() => {
  for (const key of Object.keys(KEYS)) delete process.env[key]
})
afterEach(() => setAuthSourceForTests(null))

const NOBODY: AuthFacts = { userId: null, orgId: null, isOrgAdmin: false, claims: null }
const ADMIN: AuthFacts = { userId: 'user_ada', orgId: 'org_team', isOrgAdmin: true, claims: { name: 'Ada' } }
const MEMBER: AuthFacts = { userId: 'user_max', orgId: 'org_team', isOrgAdmin: false, claims: { name: 'Max' } }
const OUTSIDER: AuthFacts = { userId: 'user_eve', orgId: 'org_other', isOrgAdmin: true, claims: { name: 'Eve' } }

function as(facts: AuthFacts): void {
  setAuthSourceForTests(async () => facts)
}

function req(path: string, method = 'GET', body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  })
}

const at = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) })

async function json(response: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

/** A bot in the team workspace, made by its admin, with the given tools. */
async function teamBot(tools: ToolName[]): Promise<string> {
  as(ADMIN)
  const created = await json(await channels.POST(req('/api/channels', 'POST', { name: 'Team Bot', assistant: { ...DEFAULT_ASSISTANT, tools } })))
  assert.equal(created.status, 201)
  return (created.body.channel as { channelUrl: string }).channelUrl
}

test('nobody signed in gets 401 UNAUTHENTICATED from every signed-in route', async () => {
  as(NOBODY)
  const responses = [
    await channels.GET(),
    await channels.POST(req('/api/channels', 'POST', { name: 'x' })),
    await channels.DELETE(),
    await channel.GET(req('/api/channels/bot_x'), at({ channelUrl: 'bot_x' })),
    await messages.POST(req('/api/channels/bot_x/messages', 'POST', { message: 'hi' }), at({ channelUrl: 'bot_x' })),
    await skills.GET(),
    await models.GET(),
    await ragSearch.GET(req('/api/rag/search?q=policy')),
  ]
  for (const response of responses) {
    assert.deepEqual(await json(response), { status: 401, body: { error: 'Sign in to use OpenDots.', code: 'UNAUTHENTICATED' } })
  }
})

test('a member may create a bot without host tools, but not with one; an admin may', async () => {
  as(MEMBER)
  const withShell = await json(await channels.POST(req('/api/channels', 'POST', { name: 'Sneaky', assistant: { ...DEFAULT_ASSISTANT, tools: ['rag_search', 'shell'] } })))
  assert.equal(withShell.status, 403)
  assert.equal(withShell.body.code, 'ADMIN_ONLY')
  const plain = await channels.POST(req('/api/channels', 'POST', { name: 'Plain', assistant: { ...DEFAULT_ASSISTANT, tools: ['rag_search'] } }))
  assert.equal(plain.status, 201)
  await teamBot(['shell'])
})

test("a member's edit can remove a host tool but not add one, nor open the browser window", async () => {
  const url = await teamBot(['rag_search', 'files'])
  as(MEMBER)
  const patch = (assistant: unknown) => channel.PATCH(req(`/api/channels/${url}`, 'PATCH', { assistant }), at({ channelUrl: url }))
  const addShell = await json(await patch({ ...DEFAULT_ASSISTANT, tools: ['rag_search', 'files', 'shell'] }))
  assert.equal(addShell.status, 403)
  assert.equal(addShell.body.code, 'ADMIN_ONLY')
  const headed = await json(await patch({ ...DEFAULT_ASSISTANT, tools: ['rag_search', 'files'], browser: { headed: true } }))
  assert.equal(headed.status, 403)
  assert.equal((await patch({ ...DEFAULT_ASSISTANT, tools: ['rag_search'] })).status, 200, 'removing files is fine')
})

test('deleting bots and documents and showing the browser are admin-only', async () => {
  const url = await teamBot(['rag_search'])
  as(ADMIN)
  const doc = await json(await skills.POST(req('/api/skills', 'POST', { fileName: 'runbook.md', content: 'How the team restarts the queue.' })))
  const skillId = (doc.body.skill as { id: string }).id

  as(MEMBER)
  const refusals = [
    await channel.DELETE(req(`/api/channels/${url}`, 'DELETE'), at({ channelUrl: url })),
    await channels.DELETE(),
    await skill.DELETE(req(`/api/skills/${skillId}`, 'DELETE'), at({ skillId })),
    await browser.PATCH(req(`/api/channels/${url}/browser`, 'PATCH', { headed: true }), at({ channelUrl: url })),
  ]
  for (const response of refusals) {
    const { status, body } = await json(response)
    assert.equal(status, 403)
    assert.equal(body.code, 'ADMIN_ONLY')
  }

  as(ADMIN)
  assert.equal((await channel.DELETE(req(`/api/channels/${url}`, 'DELETE'), at({ channelUrl: url }))).status, 200)
  assert.equal((await skill.DELETE(req(`/api/skills/${skillId}`, 'DELETE'), at({ skillId }))).status, 200)
})

test("another workspace's bot is a 404, exactly like a missing one", async () => {
  const url = await teamBot(['rag_search'])
  as(OUTSIDER)
  const { status, body } = await json(await channel.GET(req(`/api/channels/${url}`), at({ channelUrl: url })))
  assert.equal(status, 404)
  assert.equal(body.code, 'CHANNEL_NOT_FOUND')
  const listed = await json(await channels.GET())
  assert.ok(!(listed.body.channels as { channelUrl: string }[]).some((c) => c.channelUrl === url))
})

test('a message is sent as the signed-in person', async () => {
  const url = await teamBot(['rag_search'])
  as(MEMBER)
  const sent = await json(await messages.POST(req(`/api/channels/${url}/messages`, 'POST', { message: 'hello' }), at({ channelUrl: url })))
  assert.equal(sent.status, 201)
  assert.deepEqual((sent.body.message as { sender: unknown }).sender, { userId: 'user_max', nickname: 'Max', colorToken: 'violet' })
})

test("a share link unlocks with no one signed in, and finds a team bot's deployment", async () => {
  const url = await teamBot(['rag_search'])
  as(MEMBER)
  const shared = await json(await deploy.POST(req(`/api/channels/${url}/deploy`, 'POST'), at({ channelUrl: url })))
  const { id, passcode } = shared.body.deployment as { id: string; passcode: string }

  as(NOBODY)
  const wrong = await unlock.POST(req(`/api/deployments/${id}/unlock`, 'POST', { passcode: 'WRONG' }), at({ deploymentId: id }))
  assert.equal(wrong.status, 401)
  const right = await unlock.POST(req(`/api/deployments/${id}/unlock`, 'POST', { passcode }), at({ deploymentId: id }))
  assert.equal(right.status, 200)
})

test('signed out, health says only whether the service is up', async () => {
  as(NOBODY)
  assert.deepEqual(await json(await health.GET()), { status: 200, body: { status: 'ok', service: 'opendots' } })
})

test("a member's first look at a brand-new team finds starter bots without host-reaching tools", async () => {
  as({ userId: 'user_new', orgId: 'org_brand_new', isOrgAdmin: false, claims: { name: 'New' } })
  const listed = await json(await channels.GET())
  const bots = listed.body.channels as { assistant: { tools: ToolName[] } | null }[]
  assert.equal(bots.length, 9)
  const granted = bots.flatMap((bot) => bot.assistant?.tools ?? []).filter((tool) => ['files', 'shell', 'skills', 'web_browser'].includes(tool))
  assert.deepEqual(granted, [], 'no admin granted them')
})

test("someone who signed up, alone in their own workspace, still cannot give a bot host access", async () => {
  as({ userId: 'user_stranger', orgId: null, isOrgAdmin: false, claims: { name: 'Stranger' } })
  const listed = await json(await channels.GET())
  const bots = listed.body.channels as { channelUrl: string; assistant: { tools: ToolName[] } | null }[]
  assert.deepEqual(bots.flatMap((b) => b.assistant?.tools ?? []).filter((t) => ['files', 'shell', 'skills', 'web_browser'].includes(t)), [], 'their starter bots come without host tools')
  const url = bots[0]!.channelUrl
  const shell = await json(await channel.PATCH(req(`/api/channels/${url}`, 'PATCH', { assistant: { ...DEFAULT_ASSISTANT, tools: ['rag_search', 'shell'] } }), at({ channelUrl: url })))
  assert.equal(shell.status, 403)
  assert.match(String(shell.body.error), /operators/)
  const created = await json(await channels.POST(req('/api/channels', 'POST', { name: 'Mine', assistant: { ...DEFAULT_ASSISTANT, tools: ['files'] } })))
  assert.equal(created.status, 403)
  const window = await browser.PATCH(req(`/api/channels/${url}/browser`, 'PATCH', { headed: true }), at({ channelUrl: url }))
  assert.equal(window.status, 403)
  assert.equal((await channel.DELETE(req(`/api/channels/${url}`, 'DELETE'), at({ channelUrl: url }))).status, 200, 'their own workspace is still theirs to tidy')
})
