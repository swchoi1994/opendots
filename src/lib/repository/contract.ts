import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HOST_TOOLS } from '../domain/assistant'
import { ROSTER } from '../domain/roster'
import { isUserMessage } from '../domain/types'
import { LOCAL_SCOPE, type ChatRepository, type Scope } from './chat-repository'

/**
 * The behaviour every ChatRepository must share. Registered once per store
 * (memory-store.test.ts, postgres-store.test.ts) so the embedded database is
 * held to exactly what the in-memory store already promises.
 */
export function repositoryContract(label: string, getRepo: (scope?: Scope) => Promise<ChatRepository>): void {
  test(`${label}: seed is the roster, each bot with one intro message from itself`, async () => {
    const repo = await getRepo()
    const channels = await repo.listChannels()
    assert.equal(channels.length, ROSTER.length)
    const chief = channels.find((c) => c.assistant?.name === 'Chief of Staff')
    assert.ok(chief)
    assert.equal(chief.channelUrl, 'bot_chief-of-staff')
    const thread = await repo.listMessages(chief.channelUrl)
    assert.equal(thread?.length, 1)
    const first = thread![0]!.message
    assert.ok(isUserMessage(first))
    assert.equal(first.sender.userId, `bot_${chief.channelUrl}`)
    assert.equal(first.sender.nickname, 'Chief of Staff')
  })

  test(`${label}: assistant replies are attributed to the bot, not a shared Assistant user`, async () => {
    const repo = await getRepo()
    const created = await repo.createChannel({
      name: 'Apartment Hunter',
      assistant: { ...(await repo.listChannels())[0]!.assistant!, name: 'Apartment Hunter', avatar: { shape: 'cloud', color: 'green' } },
    })
    const reply = await repo.appendAssistantMessage(created.channelUrl, 'found 3 listings')
    assert.equal(reply.sender.nickname, 'Apartment Hunter')
    assert.equal(reply.sender.colorToken, 'green')
  })

  test(`${label}: bot sessions are stored per channel with the provider that made them, and cleared on delete`, async () => {
    const repo = await getRepo()
    const created = await repo.createChannel({ name: 'Temp', assistant: (await repo.listChannels())[0]!.assistant! })
    assert.equal(await repo.getBotSession(created.channelUrl), null)
    await repo.setBotSession(created.channelUrl, 'sess-1', 'ollama')
    assert.deepEqual(await repo.getBotSession(created.channelUrl), { sessionId: 'sess-1', provider: 'ollama' })
    await repo.setBotSession(created.channelUrl, 'sess-2', 'anthropic')
    assert.deepEqual(await repo.getBotSession(created.channelUrl), { sessionId: 'sess-2', provider: 'anthropic' })
    await repo.clearBotSession(created.channelUrl)
    assert.equal(await repo.getBotSession(created.channelUrl), null)
    await repo.setBotSession(created.channelUrl, 'sess-3', 'ollama')
    await repo.deleteChannel(created.channelUrl)
    assert.equal(await repo.getBotSession(created.channelUrl), null)
  })

  test(`${label}: listSkillIds tracks listSkills without the bodies, including deletes`, async () => {
    const repo = await getRepo()
    const before = await repo.listSkillIds()
    const created = await repo.createSkill({
      fileName: 'skill-ids-check.md',
      content: 'A skill uploaded only to exercise listSkillIds.',
    })
    assert.deepEqual(new Set(await repo.listSkillIds()), new Set([...before, created.id]))
    await repo.deleteSkill(created.id)
    assert.deepEqual(new Set(await repo.listSkillIds()), new Set(before))
  })

  test(`${label}: renaming a bot renames its conversation, not just the config`, async () => {
    const repo = await getRepo()
    const template = (await repo.listChannels())[0]?.assistant
    assert.ok(template)
    const created = await repo.createChannel({ name: 'Old Name', assistant: { ...template, name: 'Old Name' } })
    const updated = await repo.updateAssistant(created.channelUrl, { ...template, name: 'New Name' })
    assert.equal(updated.name, 'New Name')
    assert.equal((await repo.getChannel(created.channelUrl))?.name, 'New Name')
    const listed = (await repo.listChannels()).find((c) => c.channelUrl === created.channelUrl)
    assert.equal(listed?.name, 'New Name', 'the sidebar reads the channel name, so a rename must reach it')
    assert.equal(listed?.assistant?.name, 'New Name')
  })

  test(`${label}: screens append, list by turn, attach to a message, and cascade on delete`, async () => {
    const repo = await getRepo()
    const created = await repo.createChannel({ name: 'Screens Bot', assistant: (await repo.listChannels())[0]!.assistant! })
    const base = { channelUrl: created.channelUrl, turnId: 't1', action: 'open', target: null, intent: 'open it', url: 'https://example.com/', title: 'Example', annotations: [], flagged: false }
    const first = await repo.appendScreen({ ...base, step: 1, imagePath: '/tmp/1.jpg' })
    const second = await repo.appendScreen({ ...base, step: 2, imagePath: null, action: 'click', target: '@e1' })
    assert.equal(first.imageUrl, `/api/channels/${created.channelUrl}/screens/${first.screenId}`)
    assert.equal(second.imageUrl, null)
    const listed = await repo.listScreens(created.channelUrl, { turnId: 't1' })
    assert.deepEqual(listed.map((s) => s.step), [1, 2])
    assert.equal(await repo.getScreenImagePath(created.channelUrl, first.screenId), '/tmp/1.jpg')
    assert.equal(await repo.getScreenImagePath('other', first.screenId), null)
    assert.equal(
      await repo.getScreenImagePath(created.channelUrl, first.screenId, { attachedOnly: true }),
      null,
      'an unattached frame is withheld from the attached-only lookup',
    )
    const reply = await repo.appendAssistantMessage(created.channelUrl, 'done')
    await repo.attachScreensToMessage(created.channelUrl, 't1', reply.messageId)
    assert.ok((await repo.listScreens(created.channelUrl)).every((s) => s.messageId === reply.messageId))
    assert.equal(
      await repo.getScreenImagePath(created.channelUrl, first.screenId, { attachedOnly: true }),
      '/tmp/1.jpg',
      'once attached to the stored reply the same frame is servable',
    )
    await repo.deleteChannel(created.channelUrl)
    assert.deepEqual(await repo.listScreens(created.channelUrl), [])
  })

  test(`${label}: listScreens orders interleaved turns by start time, newest first, steps ascending within a turn`, async () => {
    const repo = await getRepo()
    const created = await repo.createChannel({ name: 'Interleaved Bot', assistant: (await repo.listChannels())[0]!.assistant! })
    const base = { channelUrl: created.channelUrl, action: 'open', target: null, intent: 'open it', url: 'https://example.com/', title: 'Example', annotations: [], flagged: false, imagePath: null }
    await repo.appendScreen({ ...base, turnId: 't1', step: 1 })
    await repo.appendScreen({ ...base, turnId: 't2', step: 1 })
    await repo.appendScreen({ ...base, turnId: 't1', step: 2 })
    const listed = await repo.listScreens(created.channelUrl)
    assert.deepEqual(listed.map((s) => `${s.turnId}-${s.step}`), ['t2-1', 't1-1', 't1-2'])
  })

  const ALICE_IN_ALPHA: Scope = { workspaceId: 'org_alpha', actor: { userId: 'user_alice', name: 'Alice' } }
  const BOB_IN_ALPHA: Scope = { workspaceId: 'org_alpha', actor: { userId: 'user_bob', name: 'Bob' } }
  const BOB_IN_BETA: Scope = { workspaceId: 'org_beta', actor: { userId: 'user_bob', name: 'Bob' } }
  const template = async () => (await (await getRepo(LOCAL_SCOPE)).listChannels())[0]!.assistant!

  test(`${label}: each workspace is seeded with its own nine bots, at urls no other workspace uses`, async () => {
    const alpha = await (await getRepo(ALICE_IN_ALPHA)).listChannels()
    const beta = await (await getRepo(BOB_IN_BETA)).listChannels()
    assert.equal(alpha.length, ROSTER.length)
    assert.equal(beta.length, ROSTER.length)
    assert.ok(alpha.every((c) => /^bot_[a-z-]+_[0-9a-f]{8}$/.test(c.channelUrl)), 'seed urls outside local carry a workspace suffix')
    const alphaUrls = new Set(alpha.map((c) => c.channelUrl))
    assert.ok(beta.every((c) => !alphaUrls.has(c.channelUrl)))
    assert.equal((await (await getRepo(BOB_IN_ALPHA)).listChannels()).length, ROSTER.length, 'a second person in the same workspace sees the same bots')
  })

  test(`${label}: a team's starter bots have no host-reaching tools until an admin grants them; a personal workspace's keep theirs`, async () => {
    const hostTools = (channels: { assistant: { tools: string[] } | null }[]) =>
      channels.flatMap((c) => c.assistant?.tools ?? []).filter((tool) => (HOST_TOOLS as readonly string[]).includes(tool))
    const team = await (await getRepo({ workspaceId: 'org_fresh', actor: { userId: 'user_max', name: 'Max' } })).listChannels()
    assert.deepEqual(hostTools(team), [])
    const own = await (await getRepo({ workspaceId: 'user_solo', actor: { userId: 'user_solo', name: 'Solo' } })).listChannels()
    assert.ok(hostTools(own).length > 0, 'an owner alone gets the defaults, as in local mode')
  })

  test(`${label}: a workspace can neither see nor touch another workspace's channels`, async () => {
    const alpha = await getRepo(ALICE_IN_ALPHA)
    const beta = await getRepo(BOB_IN_BETA)
    const tpl = await template()
    const { channelUrl } = await alpha.createChannel({ name: 'Alpha Only', assistant: tpl })
    assert.ok(!(await beta.listChannels()).some((c) => c.channelUrl === channelUrl))
    assert.equal(await beta.getChannel(channelUrl), null)
    assert.equal(await beta.listMessages(channelUrl), null)
    assert.equal(await beta.getBotSession(channelUrl), null)
    assert.deepEqual(await beta.listScreens(channelUrl), [])
    // The methods that do nothing on a miss must do nothing here too.
    await alpha.setBotSession(channelUrl, 'alpha-session', 'ollama')
    const screen = await alpha.appendScreen({
      channelUrl, turnId: 't1', step: 1, action: 'open', target: null, intent: null,
      url: 'https://example.com', title: 'Example', imagePath: '/tmp/alpha.jpg', annotations: [], flagged: false,
    })
    await beta.clearBotSession(channelUrl)
    await beta.attachScreensToMessage(channelUrl, 't1', 1)
    assert.equal(await beta.getScreenImagePath(channelUrl, screen.screenId), null)
    assert.equal((await alpha.getBotSession(channelUrl))?.sessionId, 'alpha-session', "beta can't clear alpha's session")
    assert.equal((await alpha.listScreens(channelUrl))[0]?.messageId, null, "beta can't attach alpha's screens")
    const attempts: (() => Promise<unknown>)[] = [
      () => beta.sendMessage(channelUrl, 'hi'),
      () => beta.appendAssistantMessage(channelUrl, 'hi'),
      () => beta.markRead(channelUrl),
      () => beta.updateAssistant(channelUrl, tpl),
      () => beta.deployChannel(channelUrl),
      () => beta.setBotSession(channelUrl, 's', 'ollama'),
      () => beta.deleteChannel(channelUrl),
    ]
    for (const attempt of attempts) {
      await assert.rejects(attempt(), (error: unknown) => (error as { code?: string }).code === 'CHANNEL_NOT_FOUND')
    }
    assert.ok(await alpha.getChannel(channelUrl), 'its own workspace still has it')
  })

  test(`${label}: documents belong to a workspace too`, async () => {
    const alpha = await getRepo(ALICE_IN_ALPHA)
    const beta = await getRepo(BOB_IN_BETA)
    const skill = await alpha.createSkill({ fileName: 'alpha-only.md', content: 'A document only Alpha may see.' })
    assert.ok((await alpha.listSkillIds()).includes(skill.id))
    assert.ok(!(await beta.listSkillIds()).includes(skill.id))
    assert.ok(!(await beta.listSkills()).some((s) => s.id === skill.id))
    await assert.rejects(beta.deleteSkill(skill.id), (error: unknown) => (error as { code?: string }).code === 'SKILL_NOT_FOUND')
  })

  test(`${label}: a message is sent as the scope's person, and unread counts are per person`, async () => {
    const alice = await getRepo(ALICE_IN_ALPHA)
    const bob = await getRepo(BOB_IN_ALPHA)
    const { channelUrl } = await alice.createChannel({ name: 'Shared', assistant: await template() })
    const sent = await alice.sendMessage(channelUrl, 'hello team')
    assert.equal(sent.sender.userId, 'user_alice')
    assert.equal(sent.sender.nickname, 'Alice')
    assert.equal((await bob.listMessages(channelUrl))!.at(-1)!.message.sender.nickname, 'Alice')
    const unreadFor = async (repo: ChatRepository) => (await repo.listChannels()).find((c) => c.channelUrl === channelUrl)!.unreadMessageCount
    assert.equal(await unreadFor(alice), 0, 'sending is reading')
    assert.equal(await unreadFor(bob), 1, 'Bob has not read it')
    await bob.markRead(channelUrl)
    assert.equal(await unreadFor(bob), 0)
  })

  test(`${label}: a share link knows its workspace, and anyone may look it up by id`, async () => {
    const alpha = await getRepo(ALICE_IN_ALPHA)
    const { channelUrl } = await alpha.createChannel({ name: 'Shared Out', assistant: await template() })
    const deployment = await alpha.deployChannel(channelUrl)
    assert.equal(deployment.workspaceId, 'org_alpha')
    const found = await (await getRepo(BOB_IN_BETA)).getDeployment(deployment.id)
    assert.equal(found?.channelUrl, channelUrl)
    assert.equal(found?.workspaceId, 'org_alpha')
  })

  test(`${label}: deleting everything deletes only the scope's workspace`, async () => {
    const alpha = await getRepo(ALICE_IN_ALPHA)
    const beta = await getRepo(BOB_IN_BETA)
    const { channelUrl } = await alpha.createChannel({ name: 'Survivor', assistant: await template() })
    await beta.listChannels()
    assert.ok((await beta.deleteAllChannels()) > 0)
    assert.ok(await alpha.getChannel(channelUrl))
  })

  // Last: it moves the local workspace's data away.
  test(`${label}: the first personal sign-in claims the local data, exactly once`, async () => {
    const local = await getRepo(LOCAL_SCOPE)
    const tpl = await template()
    const localUrl = (await local.listChannels())[0]!.channelUrl
    const skill = await local.createSkill({ fileName: 'before-sign-in.md', content: 'A document made before anyone signed in.' })
    const aliceHome: Scope = { workspaceId: 'user_alice', actor: { userId: 'user_alice', name: 'Alice' } }
    const alice = await getRepo(aliceHome)
    const localUrls = (await local.listChannels()).map((c) => c.channelUrl).sort()
    const localSkills = (await local.listSkillIds()).sort()
    assert.equal(await alice.claimLocalData('user_alice'), 'claimed')
    const claimed = await alice.listChannels()
    assert.deepEqual(claimed.map((c) => c.channelUrl).sort(), localUrls, 'every local bot moved, and no starter set was added')
    assert.ok(localUrls.includes(localUrl))
    assert.deepEqual((await alice.listSkillIds()).sort(), localSkills, 'every local document moved')
    assert.ok(localSkills.includes(skill.id))
    assert.deepEqual(await local.listChannels(), [], 'nothing is left in local')
    assert.deepEqual(await local.listSkillIds(), [])
    assert.equal(
      claimed.reduce((sum, c) => sum + c.unreadMessageCount, 0),
      0,
      "what the local person had read, the claimant has read",
    )

    const bob = await getRepo({ workspaceId: 'user_bob', actor: { userId: 'user_bob', name: 'Bob' } })
    assert.equal(await bob.claimLocalData('user_bob'), 'already', 'a second person gets nothing')
    const later = await local.createChannel({ name: 'Made Later', assistant: tpl })
    assert.equal(await bob.claimLocalData('user_bob'), 'already')
    assert.ok(await local.getChannel(later.channelUrl), 'data created after the claim stays local')
  })
}
