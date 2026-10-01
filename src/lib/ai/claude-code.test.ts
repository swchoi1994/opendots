import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { classifyError, describeBrain, mapSdkMessage, runBot, scrubbedEnv, type QueryFn } from './claude-code'

test('scrubbedEnv passes an allowlist and drops this server\'s secrets', () => {
  const env = scrubbedEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://user:pw@host/db',
    DEPLOYMENT_SESSION_SECRET: 'hmac-key',
    PATH: '/usr/bin',
    HOME: '/home/bot',
    CLAUDE_CODE_OAUTH_TOKEN: 'tok',
  })
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'NO_COLOR', 'PATH'])
  assert.equal(env.DATABASE_URL, undefined)
  assert.equal(env.DEPLOYMENT_SESSION_SECRET, undefined)
  assert.equal(env.NO_COLOR, '1')
  assert.equal(env.PATH, '/usr/bin')
  // Nothing is invented for a var the host never set.
  assert.equal(scrubbedEnv({ NODE_ENV: 'test' }).CLAUDE_CODE_OAUTH_TOKEN, undefined)
})

test('describeBrain reports dry-run and the auth source', () => {
  const saved = { ...process.env }
  process.env.BRAIN_DRY_RUN = '1'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.ANTHROPIC_API_KEY
  assert.deepEqual(describeBrain(), { provider: 'claude_code', mode: 'dry-run', auth: 'local_login' })
  delete process.env.BRAIN_DRY_RUN
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'x'
  assert.equal(describeBrain().auth, 'oauth_token')
  assert.equal(describeBrain().mode, 'live')
  process.env = saved
})

test('classifyError maps provider failures to UI kinds', () => {
  assert.equal(classifyError('429 rate limit exceeded'), 'usage_limit')
  assert.equal(classifyError('You have exceeded your usage limit for this period'), 'usage_limit')
  assert.equal(classifyError('Not logged in. Please run /login'), 'auth')
  assert.equal(classifyError('No conversation found with session ID abc'), 'session_not_found')
  assert.equal(classifyError('something else'), 'other')
})

test('mapSdkMessage turns SDK messages into bot events', () => {
  const pending = new Map<string, string>()
  const events = [
    { type: 'system', subtype: 'init', session_id: 's1' },
    { type: 'stream_event', session_id: 's1', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } } },
    { type: 'assistant', session_id: 's1', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__opendots__search_knowledge', input: { query: 'rollback' } }] } },
    { type: 'user', session_id: 's1', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '2 passages' }], is_error: false }] } },
    { type: 'result', subtype: 'success', session_id: 's1', result: 'Hello', total_cost_usd: 0.01, num_turns: 2 },
    { type: 'result', subtype: 'error_during_execution', session_id: 's1', errors: ['rate limit'] },
  ].flatMap((m) => mapSdkMessage(m as unknown as SDKMessage, pending))

  assert.deepEqual(events[0], { type: 'session', sessionId: 's1' })
  assert.deepEqual(events[1], { type: 'text', delta: 'Hel' })
  assert.equal(events[2]?.type, 'tool_start')
  assert.ok(events[2]?.type === 'tool_start' && events[2].summary.includes('rollback'))
  assert.deepEqual(events[3], { type: 'tool_result', name: 'mcp__opendots__search_knowledge', ok: true, summary: '2 passages' })
  assert.deepEqual(events[4], { type: 'result', text: 'Hello', sessionId: 's1', costUsd: 0.01, turns: 2 })
  assert.deepEqual(events[5], { type: 'error', message: 'rate limit', kind: 'usage_limit' })
})

test('runBot passes the workspace, resume id, and grants to query() and yields mapped events', async (t) => {
  const previous = process.env.DATABASE_URL
  process.env.DATABASE_URL = 'postgres://user:pw@host/db'
  t.after(() => {
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  })

  let captured: Record<string, unknown> | undefined
  const fakeQuery = ((args: { prompt: string; options?: Record<string, unknown> }) => {
    captured = args.options
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's9' }
      yield { type: 'result', subtype: 'success', session_id: 's9', result: 'ok', total_cost_usd: 0, num_turns: 1 }
    })()
  }) as unknown as QueryFn

  const events = []
  for await (const event of runBot(
    {
      model: 'sonnet', systemPrompt: 'be brief', prompt: 'hi', sessionId: 'old', workspaceDir: '/tmp/ws',
      builtinTools: ['Read'], allowedTools: ['Read', 'mcp__opendots__search_knowledge'], maxTurns: 3,
    },
    { query: fakeQuery },
  )) events.push(event)

  assert.equal(captured?.cwd, '/tmp/ws')
  assert.equal(captured?.resume, 'old')
  assert.deepEqual(captured?.tools, ['Read'])
  assert.deepEqual(captured?.allowedTools, ['Read', 'mcp__opendots__search_knowledge'])
  assert.equal(captured?.maxTurns, 3)
  assert.equal(captured?.includePartialMessages, true)
  const env = captured?.env as Record<string, string>
  assert.equal(env.DATABASE_URL, undefined, 'the CLI subprocess must not inherit this server\'s secrets')
  assert.equal(env.NO_COLOR, '1')
  const canUseTool = captured?.canUseTool as (name: string, input: unknown, o: unknown) => Promise<{ behavior: string }>
  assert.equal((await canUseTool('Read', {}, {})).behavior, 'allow')
  assert.equal((await canUseTool('Bash', {}, {})).behavior, 'deny')
  assert.deepEqual(events.map((e) => e.type), ['session', 'result'])
})

test('runBot turns a thrown spawn error into an error event', async () => {
  const throwing = (() => { throw new Error('spawn failed: not logged in') }) as unknown as QueryFn
  const events = []
  for await (const event of runBot(
    { model: 'sonnet', systemPrompt: '', prompt: 'x', sessionId: null, workspaceDir: '/tmp', builtinTools: [], allowedTools: [], maxTurns: 1 },
    { query: throwing },
  )) events.push(event)
  assert.equal(events[0]?.type, 'error')
  assert.equal(events[0]?.type === 'error' && events[0].kind, 'auth')
})

test('runBot aborts the SDK run when the consumer stops reading', async () => {
  let captured: Record<string, unknown> | undefined
  let drained = 0
  const fakeQuery = ((args: { prompt: string; options?: Record<string, unknown> }) => {
    captured = args.options
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1' }
      drained += 1
      yield { type: 'result', subtype: 'success', session_id: 's1', result: 'late', total_cost_usd: 0, num_turns: 1 }
      drained += 1
    })()
  }) as unknown as QueryFn

  // Break after the first event, as a disconnected client's stream does.
  for await (const event of runBot(
    { model: 'sonnet', systemPrompt: '', prompt: 'x', sessionId: null, workspaceDir: '/tmp', builtinTools: [], allowedTools: [], maxTurns: 1 },
    { query: fakeQuery },
  )) {
    assert.equal(event.type, 'session')
    break
  }

  const controller = captured?.abortController as AbortController
  assert.equal(controller.signal.aborted, true, 'closing the generator must abort the CLI subprocess')
  // The fake never resumes past its first yield: nothing is pulled from the SDK
  // once the consumer is gone, so no further turn is paid for.
  assert.equal(drained, 0, 'the SDK stream must not be advanced after the consumer left')
})
