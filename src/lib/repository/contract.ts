import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ROSTER } from '../domain/roster'
import { isUserMessage } from '../domain/types'
import type { ChatRepository } from './chat-repository'

/**
 * The behaviour every ChatRepository must share. Registered once per store
 * (memory-store.test.ts, postgres-store.test.ts) so the embedded database is
 * held to exactly what the in-memory store already promises.
 */
export function repositoryContract(label: string, getRepo: () => Promise<ChatRepository>): void {
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

  test(`${label}: bot sessions are stored per channel and cleared on delete`, async () => {
    const repo = await getRepo()
    const created = await repo.createChannel({ name: 'Temp', assistant: (await repo.listChannels())[0]!.assistant! })
    assert.equal(await repo.getBotSession(created.channelUrl), null)
    await repo.setBotSession(created.channelUrl, 'sess-1')
    assert.equal(await repo.getBotSession(created.channelUrl), 'sess-1')
    await repo.clearBotSession(created.channelUrl)
    assert.equal(await repo.getBotSession(created.channelUrl), null)
    await repo.setBotSession(created.channelUrl, 'sess-2')
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
}
