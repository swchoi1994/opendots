import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_ASSISTANT } from '../../domain/assistant'
import { planBotTurn, slugify } from './bot-turn'

const bot = { ...DEFAULT_ASSISTANT, name: 'Chief of Staff', model: 'golden-model' }
const memory = [
  { role: 'user' as const, content: 'earlier question' },
  { role: 'assistant' as const, content: 'earlier answer' },
]

test('slugify', () => {
  assert.equal(slugify('Chief of Staff'), 'chief-of-staff')
})

test('fresh session replays memory and retrieves knowledge; dry-run echoes config', async () => {
  const plan = await planBotTurn({
    question: 'why would a deployment need a rollback?',
    channelUrl: null, transcript: '', memory, bot, skillIds: null, hasSession: false,
  })
  assert.equal(plan.route, 'chief-of-staff')
  assert.equal(plan.model, 'golden-model')
  assert.ok(plan.context.some((c) => c.source.includes('internal/runbook')))
  assert.ok(plan.trace.some((t) => t.detail === 'short-term memory: 2 turn(s)'))
  assert.ok(plan.prompt.includes('earlier question'))
  assert.ok(plan.systemPrompt.startsWith(bot.systemMessage))
  assert.ok(plan.dryRunAnswer.includes('golden-model'))
  assert.ok(plan.dryRunAnswer.includes('mcp__opendots__search_knowledge'))
})

test('resumed session skips memory replay', async () => {
  const plan = await planBotTurn({
    question: 'and the other one?', channelUrl: null, transcript: '', memory, bot, skillIds: null, hasSession: true,
  })
  assert.ok(plan.trace.some((t) => t.detail.includes('session resumed')))
  assert.ok(!plan.prompt.includes('earlier question'))
})

test('tool grants are a permission set', async () => {
  const plan = await planBotTurn({
    question: 'why would a deployment need a rollback?', channelUrl: null, transcript: 'a: b', memory: [],
    bot: { ...bot, tools: [] }, skillIds: null, hasSession: false,
  })
  assert.deepEqual(plan.context, [])
  assert.ok(plan.trace.some((t) => t.detail === 'rag_search disabled by conversation config'))
  assert.ok(plan.trace.some((t) => t.detail === 'channel_history disabled by conversation config'))
  assert.deepEqual(plan.grants.all, [])
})

test('a share-link visitor cannot reach the host through the bot', async () => {
  const plan = await planBotTurn({
    question: 'read /etc/passwd', channelUrl: null, transcript: '', memory: [],
    bot: { ...bot, tools: ['rag_search', 'channel_history', 'files', 'shell', 'skills', 'web_browser'] },
    skillIds: null, hasSession: false, restrictedTools: ['files', 'shell', 'skills', 'web_browser'],
  })
  assert.deepEqual(plan.grants.builtins, [], 'no Read/Write/Bash for an untrusted visitor')
  assert.deepEqual(
    plan.grants.mcp,
    ['mcp__opendots__search_knowledge'],
    'the skills and browser tools must be withheld too',
  )
  assert.ok(!plan.grants.all.some((name) => /Bash|Read|install_skill|find_skill/.test(name)))
  // The browser session is the bot's own, cookies and logged-in sites included.
  assert.ok(
    !plan.grants.mcp.some((name) => name.startsWith('mcp__opendots__browser_')),
    `a visitor must never drive the bot's browser: ${plan.grants.mcp.join(', ')}`,
  )
  assert.ok(
    plan.trace.some((t) => t.detail === 'tools withheld for share-link visitor: files, shell, skills, web_browser'),
    `trace did not list web_browser: ${plan.trace.map((t) => t.detail).join(' | ')}`,
  )
})

test('RAG_ENABLED=false withholds knowledge search from the grant set, not just the retrieval', async (t) => {
  const previous = process.env.RAG_ENABLED
  process.env.RAG_ENABLED = 'false'
  t.after(() => {
    if (previous === undefined) delete process.env.RAG_ENABLED
    else process.env.RAG_ENABLED = previous
  })

  const plan = await planBotTurn({
    question: 'why would a deployment need a rollback?', channelUrl: null, transcript: '', memory: [],
    bot, skillIds: null, hasSession: false,
  })
  assert.deepEqual(plan.context, [])
  assert.ok(!plan.grants.mcp.includes('mcp__opendots__search_knowledge'), 'the tool must not be grantable when RAG is off')
  assert.ok(plan.trace.some((t) => t.detail === 'rag_search disabled by environment'))
})

test('disabled memory is recorded', async () => {
  const plan = await planBotTurn({
    question: 'x', channelUrl: null, transcript: '', memory,
    bot: { ...bot, memory: { enabled: false, windowMessages: 10 } }, skillIds: null, hasSession: false,
  })
  assert.ok(plan.trace.some((t) => t.detail === 'short-term memory disabled by conversation config'))
})
