import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { loadTurnContext, runBotTurn, VISITOR_RESTRICTED_TOOLS, type TurnEvent } from './run-bot-turn'
import type { BotEvent, BotRunInput, runBot } from '../claude-code'
import type { ScreenCapture } from '../tools/browser-tools'
import { memoryRepository } from '../../repository/memory-store'

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

  await memoryRepository.setBotSession(CHANNEL, 'stale')
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

  assert.equal(await memoryRepository.getBotSession(CHANNEL), 'fresh-1')

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
