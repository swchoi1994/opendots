import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { EMPTY_ANSWER, loadTurnContext, runBotTurn, VISITOR_RESTRICTED_TOOLS, type TurnEvent } from './run-bot-turn'
import type { BotEvent, BotRunInput, runBot } from '../brain'
import type { ScreenCapture } from '../tools/browser-tools'
import { createMemoryRepository, memoryRepository } from '../../repository/memory-store'
import { DEFAULT_ASSISTANT } from '../../domain/assistant'

// Seeded bots use the `default` model id. Pin what it resolves to so no test
// in this file ever probes a real Ollama.
process.env.OPENDOTS_DEFAULT_MODEL = 'sonnet'

// The repository is chosen from DATA_STORE on first use: pin the memory store
// so running this file on its own (without `pnpm test`) never opens
// ./.opendots/db in the repository.
process.env.DATA_STORE = 'memory'

// Every turn in this file, including the ones that never call
// useTempWorkspaces, creates its workspace under a throwaway root rather than
// ./.opendots/workspaces in the repository.
const FILE_WORKSPACES = mkdtempSync(join(tmpdir(), 'opendots-turn-file-'))
process.env.OPENDOTS_WORKSPACES_DIR = FILE_WORKSPACES
after(() => rmSync(FILE_WORKSPACES, { recursive: true, force: true }))

const CHANNEL = 'bot_chief-of-staff'

/** Captured by `onBrowserHook` so a fake brain can simulate a mid-turn browser capture. */
let capturedHook: ((c: ScreenCapture) => Promise<void>) | null = null

/** Restores an env var to exactly what it was, including "not set at all". */
function setEnv(t: TestContext, key: string, value: string | undefined): void {
  const previous = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  t.after(() => {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  })
}

/** Points workspaces at a throwaway directory so a live-path test writes nothing here. */
function useTempWorkspaces(t: TestContext): void {
  const root = mkdtempSync(join(tmpdir(), 'opendots-turn-'))
  setEnv(t, 'OPENDOTS_WORKSPACES_DIR', root)
  t.after(() => rmSync(root, { recursive: true, force: true }))
}

/** A stand-in brain: records the inputs it was called with, replays scripted events. */
function fakeBrain(scripts: BotEvent[][]): { fn: typeof runBot; calls: BotRunInput[] } {
  const calls: BotRunInput[] = []
  const fn = ((input: BotRunInput) => {
    const script = scripts[calls.length] ?? []
    calls.push(input)
    return (async function* (): AsyncGenerator<BotEvent> {
      for (const event of script) yield event
    })()
  }) as typeof runBot
  return { fn, calls }
}

async function collect(events: AsyncGenerator<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

test('dry run streams the planner answer and persists it as the bot reply', async (t) => {
  setEnv(t, 'BRAIN_DRY_RUN', '1')

  const before = (await memoryRepository.listMessages(CHANNEL))?.length ?? 0
  await memoryRepository.sendMessage(CHANNEL, 'what can you help me with?')

  const events = await collect(runBotTurn(await loadTurnContext(CHANNEL)))

  const tokens = events.filter((event) => event.type === 'token')
  assert.ok(tokens.length > 1, 'expected the dry-run answer to be streamed in chunks')

  const done = events.find((event) => event.type === 'done')
  assert.ok(done && done.type === 'done')
  assert.ok(
    done.message.messageType === 'user' && done.message.message.startsWith('[dry run]'),
    'stored reply should be the dry-run text',
  )

  const after = await memoryRepository.listMessages(CHANNEL)
  // The user's question plus exactly one bot reply.
  assert.equal(after?.length, before + 2)
})

test('a stale session is cleared and the turn retried on a fresh one', async (t) => {
  setEnv(t, 'BRAIN_DRY_RUN', undefined)
  useTempWorkspaces(t)

  await memoryRepository.setBotSession(CHANNEL, 'stale', 'anthropic')
  await memoryRepository.sendMessage(CHANNEL, 'and the other one?')

  const brain = fakeBrain([
    [{ type: 'error', kind: 'session_not_found', message: 'No conversation found' }],
    [
      { type: 'session', sessionId: 'fresh-1' },
      { type: 'text', delta: 'here you go' },
      { type: 'result', text: 'here you go', sessionId: 'fresh-1', costUsd: 0.01, turns: 1 },
    ],
  ])

  const events = await collect(runBotTurn(await loadTurnContext(CHANNEL), {}, { runBot: brain.fn }))

  assert.equal(brain.calls.length, 2, 'the brain should have been retried once')
  assert.equal(brain.calls[0]?.sessionId, 'stale')
  assert.equal(brain.calls[1]?.sessionId, null, 'the retry must not resume the dead session')

  const trace = events.find((event) => event.type === 'trace')
  assert.ok(trace && trace.type === 'trace')
  assert.ok(
    trace.trace.some((entry) => entry.detail.includes('session stale not found, starting fresh')),
    `trace did not record the reset: ${trace.trace.map((e) => e.detail).join(' | ')}`,
  )

  assert.deepEqual(await memoryRepository.getBotSession(CHANNEL), { sessionId: 'fresh-1', provider: 'anthropic' })

  const done = events.find((event) => event.type === 'done')
  assert.ok(done && done.type === 'done')
  assert.ok(done.message.messageType === 'user' && done.message.message === 'here you go')
})

test('a brain failure with no text is persisted in-thread as an assistant error', async (t) => {
  setEnv(t, 'BRAIN_DRY_RUN', undefined)
  useTempWorkspaces(t)

  await memoryRepository.sendMessage(CHANNEL, 'summarise the week')
  const brain = fakeBrain([[{ type: 'error', kind: 'usage_limit', message: '429' }]])

  const events = await collect(runBotTurn(await loadTurnContext(CHANNEL), {}, { runBot: brain.fn }))

  const failure = events.find((event) => event.type === 'error')
  assert.ok(failure && failure.type === 'error')
  assert.equal(failure.kind, 'usage_limit')
  assert.ok(failure.error.includes('usage limit'))

  const stored = failure.message
  assert.ok(stored, 'the failure must be stored in the thread, not just streamed')
  assert.ok(stored.messageType === 'user' && stored.message.startsWith('[assistant error]'))
  assert.ok(stored.messageType === 'user' && stored.message.includes('usage limit'))

  // No `done` — the turn stops at the error.
  assert.equal(events.some((event) => event.type === 'done'), false)
})

test('a planner failure is persisted in-thread rather than lost', async (t) => {
  // pgvector has no local embeddings yet, so the retriever throws while planning.
  setEnv(t, 'RAG_VECTOR_STORE', 'pgvector')
  // Belt and braces: even if planning somehow succeeded, no real brain is called.
  setEnv(t, 'BRAIN_DRY_RUN', '1')

  await memoryRepository.sendMessage(CHANNEL, 'why would a deployment need a rollback?')

  const events = await collect(runBotTurn(await loadTurnContext(CHANNEL)))

  const failure = events.find((event) => event.type === 'error')
  assert.ok(failure && failure.type === 'error', 'the planner throw should surface as an error event')
  assert.equal(failure.kind, 'other')
  assert.ok(failure.error.includes('pgvector'))

  const stored = failure.message
  assert.ok(stored, 'the planner failure must be stored in the thread')
  assert.ok(stored.messageType === 'user' && stored.message.startsWith('[assistant error]'))
})

test('a share-link visitor gets no host-reaching tools, whatever the bot was granted', async (t) => {
  setEnv(t, 'BRAIN_DRY_RUN', undefined)
  useTempWorkspaces(t)

  const template = (await memoryRepository.listChannels())[0]?.assistant
  assert.ok(template)
  const channel = await memoryRepository.createChannel({
    name: 'Deployed Bot',
    assistant: {
      ...template,
      name: 'Deployed Bot',
      tools: ['rag_search', 'channel_history', 'files', 'shell', 'skills', 'web_browser'],
    },
  })
  await memoryRepository.sendMessage(channel.channelUrl, 'what can you do?')

  const brain = fakeBrain([[
    { type: 'session', sessionId: 'v-1' },
    { type: 'text', delta: 'sure' },
    { type: 'result', text: 'sure', sessionId: 'v-1', costUsd: 0, turns: 1 },
  ]])

  const ctx = await loadTurnContext(channel.channelUrl, 'deployment_visitor')
  assert.equal(ctx.trigger, 'deployment_visitor')
  let browserContextBuilt = false
  const events = await collect(
    runBotTurn(ctx, {}, { runBot: brain.fn, onBrowserHook: () => { browserContextBuilt = true } }),
  )

  const allowed = brain.calls[0]?.allowedTools ?? []
  assert.ok(!allowed.includes('Bash'), `Bash must never be allowed for a visitor: ${allowed.join(', ')}`)
  assert.ok(!allowed.includes('Read'), `Read must never be allowed for a visitor: ${allowed.join(', ')}`)
  assert.ok(!allowed.includes('mcp__opendots__install_skill'), 'a visitor must not be able to install skills')
  assert.ok(
    !allowed.some((name) => name.startsWith('mcp__opendots__browser_')),
    `a visitor must never drive the bot's browser: ${allowed.join(', ')}`,
  )
  assert.deepEqual(brain.calls[0]?.builtinTools, [])
  // The hook only fires when the turn built a browser context for the opendots
  // server, so this is the assertion that no browser reached the brain at all.
  assert.equal(browserContextBuilt, false, 'a visitor turn must build no browser context')

  const trace = events.find((event) => event.type === 'trace')
  assert.ok(trace && trace.type === 'trace')
  assert.ok(
    trace.trace.some(
      (entry) => entry.detail === 'tools withheld for share-link visitor: files, shell, skills, web_browser',
    ),
    `trace did not record the withholding: ${trace.trace.map((e) => e.detail).join(' | ')}`,
  )
})

test('the visitor restriction list itself withholds the browser', () => {
  assert.ok(
    VISITOR_RESTRICTED_TOOLS.includes('web_browser'),
    'web_browser must stay in VISITOR_RESTRICTED_TOOLS: a share link would otherwise drive the bot\'s own logged-in browser',
  )
  assert.deepEqual([...VISITOR_RESTRICTED_TOOLS].sort(), ['files', 'shell', 'skills', 'web_browser'])
})

test('a disabled memory window replays nothing (slice(-0) would replay everything)', async () => {
  const template = (await memoryRepository.listChannels())[0]?.assistant
  assert.ok(template)
  const channel = await memoryRepository.createChannel({
    name: 'No Memory',
    assistant: { ...template, name: 'No Memory', memory: { enabled: false, windowMessages: 10 } },
  })

  await memoryRepository.sendMessage(channel.channelUrl, 'first')
  await memoryRepository.sendMessage(channel.channelUrl, 'second')
  await memoryRepository.sendMessage(channel.channelUrl, 'third')

  const ctx = await loadTurnContext(channel.channelUrl)
  assert.deepEqual(ctx.memory, [])
  // The transcript is unaffected — only the replayed memory window is empty.
  assert.ok(ctx.transcript.includes('first'))
})

test('a screen capture is persisted and yielded as a screen event, then attached to the reply', async () => {
  const url = 'bot_chief-of-staff'
  await memoryRepository.sendMessage(url, 'open example.com')
  const ctx = await loadTurnContext(url)
  const fakeRunBot: typeof runBot = async function* (input) {
    // Simulate the browser tool firing a capture mid-run.
    const server = input.mcpServers?.opendots as { instance?: unknown } | undefined
    assert.ok(server, 'opendots server is passed to the brain')
    await capturedHook!({ step: 1, action: 'open', target: null, intent: 'open it', url: 'https://example.com/', title: 'Example', imagePath: null, annotations: [], flagged: false })
    yield { type: 'session', sessionId: 's-screen' }
    yield { type: 'text', delta: 'The heading is Example Domain.' }
    yield { type: 'result', text: 'The heading is Example Domain.', sessionId: 's-screen', costUsd: 0, turns: 1 }
  }
  const events: TurnEvent[] = []
  for await (const ev of runBotTurn(ctx, {}, { runBot: fakeRunBot, onBrowserHook: (hook) => { capturedHook = hook } })) events.push(ev)
  const screenEvent = events.find((e) => e.type === 'screen')
  assert.ok(screenEvent && screenEvent.type === 'screen')
  assert.equal(screenEvent.screen.action, 'open')
  const done = events.find((e) => e.type === 'done')
  assert.ok(done && done.type === 'done')
  const screens = await memoryRepository.listScreens(url)
  assert.equal(screens[0]?.messageId, done.message.messageId)
})

test('a bot on the default model runs on whatever the server resolves, and a local run is traced as local', async (t) => {
  setEnv(t, 'BRAIN_DRY_RUN', undefined)
  useTempWorkspaces(t)
  const created = await memoryRepository.createChannel({
    name: 'Default Model Bot',
    assistant: { ...DEFAULT_ASSISTANT, name: 'Default Model Bot' },
  })
  assert.equal(created.assistant?.model, 'default')
  await memoryRepository.sendMessage(created.channelUrl, 'which model are you?')

  const brain = fakeBrain([[{ type: 'result', text: 'a local one', sessionId: 's-local', costUsd: null, turns: 1 }]])
  const events = await collect(runBotTurn(
    await loadTurnContext(created.channelUrl),
    {},
    { runBot: brain.fn, resolveDefaultModel: async () => 'ollama/qwq:latest' },
  ))

  assert.equal(brain.calls[0]?.model, 'ollama/qwq:latest')
  const trace = events.find((event) => event.type === 'trace')
  assert.ok(trace?.type === 'trace')
  assert.ok(trace.trace.some((entry) => entry.detail === 'default model resolved to ollama/qwq:latest'))
  assert.ok(trace.trace.some((entry) => entry.detail === 'completed in 1 turn(s), local'))
})

test('a turn that ends with no answer and no error is stored and streamed as a failure', async (t) => {
  setEnv(t, 'BRAIN_DRY_RUN', undefined)
  useTempWorkspaces(t)
  await memoryRepository.sendMessage(CHANNEL, 'are you there?')

  // What qwq did in 2 of 4 live runs: thinking only, then an empty result.
  const brain = fakeBrain([[
    { type: 'session', sessionId: 's-empty' },
    { type: 'result', text: '', sessionId: 's-empty', costUsd: null, turns: 1 },
  ]])
  const events = await collect(runBotTurn(await loadTurnContext(CHANNEL), {}, { runBot: brain.fn }))

  const failure = events.find((event) => event.type === 'error')
  assert.ok(failure?.type === 'error', `expected an error event, got ${events.map((e) => e.type).join(', ')}`)
  assert.equal(failure.error, EMPTY_ANSWER)
  assert.equal(EMPTY_ANSWER, 'The model returned no answer. Try again, or pick a different model.')
  assert.ok(failure.message?.messageType === 'user')
  assert.equal(failure.message.message, `[assistant error] ${EMPTY_ANSWER}`)
  assert.equal(events.some((event) => event.type === 'done'), false)
  const thread = await memoryRepository.listMessages(CHANNEL)
  const last = thread?.at(-1)?.message
  assert.ok(last?.messageType === 'user' && last.message !== '', 'no blank bubble is stored')
})

test('the brain\'s failure text is stored as is: no Anthropic key copy on an Ollama run', async (t) => {
  setEnv(t, 'BRAIN_DRY_RUN', undefined)
  useTempWorkspaces(t)
  const template = (await memoryRepository.listChannels())[0]?.assistant
  assert.ok(template)
  const channel = await memoryRepository.createChannel({
    name: 'Local Auth Bot',
    assistant: { ...template, name: 'Local Auth Bot', model: 'ollama/qwq:latest' },
  })
  await memoryRepository.sendMessage(channel.channelUrl, 'hello')

  const brain = fakeBrain([[{ type: 'error', kind: 'auth', message: 'API Error: 401 unauthorized by the proxy in front of Ollama' }]])
  const events = await collect(runBotTurn(await loadTurnContext(channel.channelUrl), {}, { runBot: brain.fn }))

  const failure = events.find((event) => event.type === 'error')
  assert.ok(failure?.type === 'error')
  assert.doesNotMatch(failure.error, /ANTHROPIC_API_KEY/)
  assert.equal(failure.error, 'API Error: 401 unauthorized by the proxy in front of Ollama')
})

test('no CLI product name reaches the thread, even after a partial answer', async (t) => {
  setEnv(t, 'BRAIN_DRY_RUN', undefined)
  useTempWorkspaces(t)
  await memoryRepository.sendMessage(CHANNEL, 'write the report')

  const brain = fakeBrain([[
    { type: 'text', delta: 'Here is the first half' },
    { type: 'error', kind: 'other', message: 'Claude Code returned an error result: Claude Code stopped' },
  ]])
  const events = await collect(runBotTurn(await loadTurnContext(CHANNEL), {}, { runBot: brain.fn }))
  const done = events.find((event) => event.type === 'done')
  assert.ok(done?.type === 'done' && done.message.messageType === 'user')
  assert.ok(done.message.message.startsWith('Here is the first half'))
  assert.doesNotMatch(done.message.message, /claude[ -]?code/i)
})

test('a session is resumed only by the provider that created it', async (t) => {
  setEnv(t, 'BRAIN_DRY_RUN', undefined)
  useTempWorkspaces(t)
  const created = await memoryRepository.createChannel({
    name: 'Switching Bot',
    assistant: { ...DEFAULT_ASSISTANT, name: 'Switching Bot', memory: { enabled: true, windowMessages: 10 } },
  })
  const url = created.channelUrl
  const reply = (sessionId: string): BotEvent[] => [
    { type: 'session', sessionId },
    { type: 'text', delta: 'ok' },
    { type: 'result', text: 'ok', sessionId, costUsd: null, turns: 1 },
  ]

  // Turn 1 runs on Ollama (no key yet) and stores an Ollama session.
  await memoryRepository.sendMessage(url, 'first')
  const local = fakeBrain([reply('ollama-sess')])
  await collect(runBotTurn(await loadTurnContext(url), {}, { runBot: local.fn, resolveDefaultModel: async () => 'ollama/qwq:latest' }))
  assert.deepEqual(await memoryRepository.getBotSession(url), { sessionId: 'ollama-sess', provider: 'ollama' })

  // Turn 2, same provider: resumed.
  await memoryRepository.sendMessage(url, 'second')
  const again = fakeBrain([reply('ollama-sess')])
  await collect(runBotTurn(await loadTurnContext(url), {}, { runBot: again.fn, resolveDefaultModel: async () => 'ollama/qwq:latest' }))
  assert.equal(again.calls[0]?.sessionId, 'ollama-sess')

  // A key is added, so "default" now means Claude: the Ollama session must not be resumed.
  await memoryRepository.sendMessage(url, 'third')
  const claude = fakeBrain([reply('claude-sess')])
  const events = await collect(runBotTurn(await loadTurnContext(url), {}, { runBot: claude.fn, resolveDefaultModel: async () => 'sonnet' }))
  assert.equal(claude.calls[0]?.model, 'sonnet')
  assert.equal(claude.calls[0]?.sessionId, null, 'a fresh session, not the Ollama one')
  const trace = events.find((event) => event.type === 'trace')
  assert.ok(trace?.type === 'trace')
  assert.ok(
    trace.trace.some((entry) => entry.detail === 'provider changed (ollama → anthropic), starting a fresh session'),
    `trace: ${trace.trace.map((e) => e.detail).join(' | ')}`,
  )
  assert.ok(
    !trace.trace.some((entry) => entry.detail.includes('session resumed')),
    'a fresh session replays memory instead of skipping it',
  )
  assert.deepEqual(await memoryRepository.getBotSession(url), { sessionId: 'claude-sess', provider: 'anthropic' })
})

test("in a team workspace the bot reads each person's name in the transcript, and its reply stays in that workspace", async () => {
  const alpha = { workspaceId: 'org_alpha', actor: { userId: 'user_alice', name: 'Alice' } }
  const alice = createMemoryRepository(alpha)
  const bob = createMemoryRepository({ workspaceId: 'org_alpha', actor: { userId: 'user_bob', name: 'Bob' } })
  const channel = await alice.createChannel({ name: 'Team Desk', assistant: { ...DEFAULT_ASSISTANT, tools: ['channel_history'] } })
  await alice.sendMessage(channel.channelUrl, 'Can we ship Friday?')
  await bob.sendMessage(channel.channelUrl, 'Only if QA signs off.')

  const ctx = await loadTurnContext(channel.channelUrl, 'user_message', bob.scope)
  assert.match(ctx.transcript, /^Alice: Can we ship Friday\?$/m)
  assert.match(ctx.transcript, /^Bob: Only if QA signs off\.$/m)
  assert.equal(ctx.question, 'Only if QA signs off.')
  assert.deepEqual(ctx.scope, bob.scope)

  await assert.rejects(loadTurnContext(channel.channelUrl), /No channel/, 'the local workspace cannot run a team bot')
  await collect(runBotTurn(ctx))
  const thread = (await alice.listMessages(channel.channelUrl))!
  assert.ok(thread.at(-1)!.message.sender.userId.startsWith('bot_'), 'the reply landed in the team channel')
})
