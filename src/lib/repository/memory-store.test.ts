import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryRepository } from './memory-store'
import { ROSTER } from '../domain/roster'
import { isUserMessage } from '../domain/types'

test('seed is the roster, each bot with one intro message from itself', async () => {
  const channels = await memoryRepository.listChannels()
  assert.equal(channels.length, ROSTER.length)
  const chief = channels.find((c) => c.assistant?.name === 'Chief of Staff')
  assert.ok(chief)
  assert.equal(chief.channelUrl, 'bot_chief-of-staff')
  const thread = await memoryRepository.listMessages(chief.channelUrl)
  assert.equal(thread?.length, 1)
  const first = thread![0]!.message
  assert.ok(isUserMessage(first))
  assert.equal(first.sender.userId, `bot_${chief.channelUrl}`)
  assert.equal(first.sender.nickname, 'Chief of Staff')
})

test('assistant replies are attributed to the bot, not a shared Assistant user', async () => {
  const created = await memoryRepository.createChannel({
    name: 'Apartment Hunter',
    assistant: { ...(await memoryRepository.listChannels())[0]!.assistant!, name: 'Apartment Hunter', avatar: { shape: 'cloud', color: 'green' } },
  })
  const reply = await memoryRepository.appendAssistantMessage(created.channelUrl, 'found 3 listings')
  assert.equal(reply.sender.nickname, 'Apartment Hunter')
  assert.equal(reply.sender.colorToken, 'green')
})

test('bot sessions are stored per channel and cleared on delete', async () => {
  const created = await memoryRepository.createChannel({
    name: 'Temp',
    assistant: (await memoryRepository.listChannels())[0]!.assistant!,
  })
  assert.equal(await memoryRepository.getBotSession(created.channelUrl), null)
  await memoryRepository.setBotSession(created.channelUrl, 'sess-1')
  assert.equal(await memoryRepository.getBotSession(created.channelUrl), 'sess-1')
  await memoryRepository.clearBotSession(created.channelUrl)
  assert.equal(await memoryRepository.getBotSession(created.channelUrl), null)
  await memoryRepository.setBotSession(created.channelUrl, 'sess-2')
  await memoryRepository.deleteChannel(created.channelUrl)
  assert.equal(await memoryRepository.getBotSession(created.channelUrl), null)
})

test('listSkillIds tracks listSkills without the bodies, including deletes', async () => {
  const before = await memoryRepository.listSkillIds()
  const created = await memoryRepository.createSkill({
    fileName: 'skill-ids-check.md',
    content: 'A skill uploaded only to exercise listSkillIds.',
  })
  const afterCreate = await memoryRepository.listSkillIds()
  assert.deepEqual(new Set(afterCreate), new Set([...before, created.id]))

  await memoryRepository.deleteSkill(created.id)
  const afterDelete = await memoryRepository.listSkillIds()
  assert.deepEqual(new Set(afterDelete), new Set(before))
})

test('renaming a bot renames its conversation, not just the config', async () => {
  const template = (await memoryRepository.listChannels())[0]?.assistant
  assert.ok(template)
  const created = await memoryRepository.createChannel({
    name: 'Old Name',
    assistant: { ...template, name: 'Old Name' },
  })

  const updated = await memoryRepository.updateAssistant(created.channelUrl, {
    ...template,
    name: 'New Name',
  })

  assert.equal(updated.name, 'New Name')
  assert.equal((await memoryRepository.getChannel(created.channelUrl))?.name, 'New Name')
  const listed = (await memoryRepository.listChannels()).find((c) => c.channelUrl === created.channelUrl)
  assert.equal(listed?.name, 'New Name', 'the sidebar reads the channel name, so a rename must reach it')
  assert.equal(listed?.assistant?.name, 'New Name')
})

test('screens append, list by turn, attach to a message, and cascade on delete', async () => {
  const created = await memoryRepository.createChannel({ name: 'Screens Bot', assistant: (await memoryRepository.listChannels())[0]!.assistant! })
  const base = { channelUrl: created.channelUrl, turnId: 't1', action: 'open', target: null, intent: 'open it', url: 'https://example.com/', title: 'Example', annotations: [], flagged: false }
  const first = await memoryRepository.appendScreen({ ...base, step: 1, imagePath: '/tmp/1.jpg' })
  const second = await memoryRepository.appendScreen({ ...base, step: 2, imagePath: null, action: 'click', target: '@e1' })
  assert.equal(first.imageUrl, `/api/channels/${created.channelUrl}/screens/${first.screenId}`)
  assert.equal(second.imageUrl, null)
  const listed = await memoryRepository.listScreens(created.channelUrl, { turnId: 't1' })
  assert.deepEqual(listed.map((s) => s.step), [1, 2])
  assert.equal(await memoryRepository.getScreenImagePath(created.channelUrl, first.screenId), '/tmp/1.jpg')
  assert.equal(await memoryRepository.getScreenImagePath('other', first.screenId), null)
  // A share-link visitor only ever sees frames already attached to a reply.
  assert.equal(
    await memoryRepository.getScreenImagePath(created.channelUrl, first.screenId, { attachedOnly: true }),
    null,
    'an unattached frame is withheld from the attached-only lookup',
  )
  const reply = await memoryRepository.appendAssistantMessage(created.channelUrl, 'done')
  await memoryRepository.attachScreensToMessage(created.channelUrl, 't1', reply.messageId)
  assert.ok((await memoryRepository.listScreens(created.channelUrl)).every((s) => s.messageId === reply.messageId))
  assert.equal(
    await memoryRepository.getScreenImagePath(created.channelUrl, first.screenId, { attachedOnly: true }),
    '/tmp/1.jpg',
    'once attached to the stored reply the same frame is servable',
  )
  await memoryRepository.deleteChannel(created.channelUrl)
  assert.deepEqual(await memoryRepository.listScreens(created.channelUrl), [])
})

test('listScreens orders interleaved turns by start time, newest first, steps ascending within a turn', async () => {
  const created = await memoryRepository.createChannel({ name: 'Interleaved Bot', assistant: (await memoryRepository.listChannels())[0]!.assistant! })
  const base = { channelUrl: created.channelUrl, action: 'open', target: null, intent: 'open it', url: 'https://example.com/', title: 'Example', annotations: [], flagged: false, imagePath: null }
  // t1 starts, t2 starts before t1's second step lands.
  await memoryRepository.appendScreen({ ...base, turnId: 't1', step: 1 })
  await memoryRepository.appendScreen({ ...base, turnId: 't2', step: 1 })
  await memoryRepository.appendScreen({ ...base, turnId: 't1', step: 2 })

  const listed = await memoryRepository.listScreens(created.channelUrl)
  assert.deepEqual(listed.map((s) => `${s.turnId}-${s.step}`), ['t2-1', 't1-1', 't1-2'])
})
