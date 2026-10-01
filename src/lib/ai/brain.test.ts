import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { HookCallbackMatcher, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  MISSING_API_KEY,
  REJECTED_API_KEY,
  classifyError,
  describeBrain,
  explainOllamaFailure,
  mapSdkMessage,
  runBot,
  type BotEvent,
  type BotRunInput,
  type QueryFn,
} from './brain'
import { OUTSIDE_WORKSPACE } from './tools/workspace-guard'

/** A throwaway data dir per test, so no run writes under ./.opendots. */
function testEnv(t: TestContext, extra: Partial<NodeJS.ProcessEnv> = {}): Partial<NodeJS.ProcessEnv> {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-brain-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { PATH: process.env.PATH, HOME: process.env.HOME, OPENDOTS_DATA_DIR: dir, ...extra }
}

const BASE: BotRunInput = {
  model: 'sonnet',
  systemPrompt: '',
  prompt: 'x',
  sessionId: null,
  workspaceDir: tmpdir(),
  builtinTools: [],
  allowedTools: [],
  maxTurns: 1,
}

/** A fake SDK query(): records the options it was given and replays scripted messages. */
function recordingQuery(messages: unknown[]) {
  let options: Record<string, unknown> | undefined
  let calls = 0
  const fn = ((args: { prompt: string; options?: Record<string, unknown> }) => {
    calls += 1
    options = args.options
    return (async function* () {
      for (const message of messages) yield message
    })()
  }) as unknown as QueryFn
  return { fn, options: () => options, calls: () => calls }
}

/** Stand-ins for the Ollama reachability probe: unit tests never reach a real Ollama. */
const ollamaUp = async () => true
const ollamaDown = async () => false

/**
 * A fake SDK query() that replays what the real CLI does on a failure: a
 * `result` with subtype 'success' and is_error true, then the SDK's own throw
 * once the process exits (both observed against the real CLI, 0.3.286).
 */
function failingQuery(resultText: string, before: unknown[] = []) {
  let calls = 0
  const fn = (() => {
    calls += 1
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's-fail' }
      for (const message of before) yield message
      yield { type: 'assistant', session_id: 's-fail', parent_tool_use_id: null, message: { content: [{ type: 'text', text: resultText }] } }
      yield { type: 'result', subtype: 'success', is_error: true, session_id: 's-fail', result: resultText, total_cost_usd: 0, num_turns: 1 }
      throw new Error(`Claude Code returned an error result: ${resultText}`)
    })()
  }) as unknown as QueryFn
  return { fn, calls: () => calls }
}

async function collect(events: AsyncGenerator<BotEvent>): Promise<BotEvent[]> {
  const out: BotEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

test('describeBrain reports dry-run, whether a key is set, and the Ollama host', () => {
  assert.deepEqual(describeBrain({ BRAIN_DRY_RUN: '1' }), {
    mode: 'dry-run',
    anthropic: { keySet: false, customBaseUrl: false },
    ollama: { host: 'http://localhost:11434' },
  })
  const live = describeBrain({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://proxy', OLLAMA_HOST: 'gpu:11434' })
  assert.equal(live.mode, 'live')
  assert.deepEqual(live.anthropic, { keySet: true, customBaseUrl: true })
  assert.equal(live.ollama.host, 'http://gpu:11434')
})

test('classifyError maps provider failures to UI kinds', () => {
  assert.equal(classifyError('429 rate limit exceeded'), 'usage_limit')
  assert.equal(classifyError('You have exceeded your usage limit for this period'), 'usage_limit')
  assert.equal(classifyError('Invalid API key'), 'auth')
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
  assert.ok(events[2]?.type === 'tool_start' && events[2].summary.includes('rollback'))
  assert.deepEqual(events[3], { type: 'tool_result', name: 'mcp__opendots__search_knowledge', ok: true, summary: '2 passages' })
  assert.deepEqual(events[4], { type: 'result', text: 'Hello', sessionId: 's1', costUsd: 0.01, turns: 2 })
  assert.deepEqual(events[5], { type: 'error', message: 'rate limit', kind: 'usage_limit' })
})

test('runBot passes workspace, resume id, grants, a scrubbed env and the guard hook to query()', async (t) => {
  const env = testEnv(t, { ANTHROPIC_API_KEY: 'sk-ant-test', DATABASE_URL: 'postgres://user:pw@host/db' })
  const q = recordingQuery([
    { type: 'system', subtype: 'init', session_id: 's9' },
    { type: 'result', subtype: 'success', session_id: 's9', result: 'ok', total_cost_usd: 0.002, num_turns: 1 },
  ])
  const events = await collect(runBot(
    {
      ...BASE, systemPrompt: 'be brief', prompt: 'hi', sessionId: 'old', workspaceDir: '/tmp/ws',
      builtinTools: ['Read'], allowedTools: ['Read', 'mcp__opendots__search_knowledge'], maxTurns: 3,
    },
    { query: q.fn, env },
  ))

  const options = q.options()!
  assert.equal(options.model, 'sonnet')
  assert.equal(options.cwd, '/tmp/ws')
  assert.equal(options.resume, 'old')
  assert.deepEqual(options.tools, ['Read'])
  assert.deepEqual(options.allowedTools, ['Read', 'mcp__opendots__search_knowledge'])
  assert.equal(options.maxTurns, 3)
  assert.equal(options.permissionMode, 'default')
  assert.equal(options.includePartialMessages, true)
  const subEnv = options.env as Record<string, string>
  assert.equal(subEnv.DATABASE_URL, undefined, 'the CLI subprocess must not inherit this server\'s secrets')
  assert.equal(subEnv.ANTHROPIC_API_KEY, 'sk-ant-test')
  assert.equal(subEnv.CLAUDE_CONFIG_DIR, join(env.OPENDOTS_DATA_DIR!, 'claude'))
  assert.equal((options.hooks as { PreToolUse?: HookCallbackMatcher[] }).PreToolUse?.length, 1)
  const canUseTool = options.canUseTool as (name: string, input: unknown, o: unknown) => Promise<{ behavior: string }>
  assert.equal((await canUseTool('Read', {}, {})).behavior, 'allow')
  assert.equal((await canUseTool('Bash', {}, {})).behavior, 'deny')
  assert.deepEqual(events.map((e) => e.type), ['session', 'result'])
  assert.equal(events[1]?.type === 'result' && events[1].costUsd, 0.002)
})

test('the installed hook refuses a path outside the workspace', async (t) => {
  const env = testEnv(t, { ANTHROPIC_API_KEY: 'k' })
  const ws = mkdtempSync(join(tmpdir(), 'opendots-brain-ws-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }))
  const q = recordingQuery([])
  await collect(runBot({ ...BASE, workspaceDir: ws }, { query: q.fn, env }))

  const [matcher] = (q.options()!.hooks as { PreToolUse: HookCallbackMatcher[] }).PreToolUse
  const out = await matcher!.hooks[0]!(
    { session_id: 's', transcript_path: '/t', cwd: ws, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/etc/hosts' }, tool_use_id: 'u' },
    'u',
    { signal: new AbortController().signal },
  )
  assert.equal(
    (out as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason,
    OUTSIDE_WORKSPACE,
  )
})

test('an Anthropic model without ANTHROPIC_API_KEY fails before the CLI is spawned', async (t) => {
  const q = recordingQuery([])
  const events = await collect(runBot(BASE, { query: q.fn, env: testEnv(t) }))
  assert.deepEqual(events, [{ type: 'error', message: MISSING_API_KEY, kind: 'auth' }])
  assert.equal(q.calls(), 0, 'there is no fallback to a claude.ai login')
})

test('the default model id must be resolved before runBot is called', async (t) => {
  const q = recordingQuery([])
  const events = await collect(runBot({ ...BASE, model: 'default' }, { query: q.fn, env: testEnv(t, { ANTHROPIC_API_KEY: 'k' }) }))
  assert.equal(events[0]?.type, 'error')
  assert.equal(q.calls(), 0)
})

test('an Ollama model runs against Ollama, without the operator key and without a dollar cost', async (t) => {
  const env = testEnv(t, { ANTHROPIC_API_KEY: 'sk-ant-operator', OLLAMA_HOST: 'http://127.0.0.1:11434' })
  const q = recordingQuery([{ type: 'result', subtype: 'success', session_id: 's', result: 'hi', total_cost_usd: 0.42, num_turns: 2 }])
  const events = await collect(runBot({ ...BASE, model: 'ollama/qwq:latest' }, { query: q.fn, env, probeOllama: ollamaUp }))

  const options = q.options()!
  assert.equal(options.model, 'qwq:latest')
  const subEnv = options.env as Record<string, string>
  assert.equal(subEnv.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11434')
  assert.equal(subEnv.ANTHROPIC_API_KEY, undefined)
  assert.deepEqual(events, [{ type: 'result', text: 'hi', sessionId: 's', costUsd: null, turns: 2 }])
})

test('Ollama connection and missing-model failures say what to do', async (t) => {
  const env = testEnv(t, { OLLAMA_HOST: 'http://127.0.0.1:11434' })
  const refused = (() => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434') }) as unknown as QueryFn
  const [down] = await collect(runBot({ ...BASE, model: 'ollama/qwq:latest' }, { query: refused, env, probeOllama: ollamaUp }))
  assert.equal(down?.type === 'error' && down.message, "Ollama isn't answering at http://127.0.0.1:11434. Start it with `ollama serve`.")

  const qwq = { provider: 'ollama' as const, sdkModel: 'qwq:latest' }
  assert.equal(
    explainOllamaFailure('model "qwq:latest" not found, try pulling it first', qwq, 'http://h'),
    "qwq:latest isn't pulled. Run `ollama pull qwq:latest`.",
  )
  assert.equal(explainOllamaFailure('something else', qwq, 'http://h'), 'something else')
})

test('runBot turns a thrown spawn error into an error event', async (t) => {
  const throwing = (() => { throw new Error('spawn failed: invalid api key') }) as unknown as QueryFn
  const events = await collect(runBot(BASE, { query: throwing, env: testEnv(t, { ANTHROPIC_API_KEY: 'k' }) }))
  assert.equal(events[0]?.type === 'error' && events[0].kind, 'auth')
})

test('runBot aborts the SDK run when the consumer stops reading', async (t) => {
  let drained = 0
  let options: Record<string, unknown> | undefined
  const fakeQuery = ((args: { prompt: string; options?: Record<string, unknown> }) => {
    options = args.options
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1' }
      drained += 1
      yield { type: 'result', subtype: 'success', session_id: 's1', result: 'late', total_cost_usd: 0, num_turns: 1 }
      drained += 1
    })()
  }) as unknown as QueryFn

  for await (const event of runBot(BASE, { query: fakeQuery, env: testEnv(t, { ANTHROPIC_API_KEY: 'k' }) })) {
    assert.equal(event.type, 'session')
    break
  }

  assert.equal((options?.abortController as AbortController).signal.aborted, true, 'closing the generator must abort the CLI subprocess')
  assert.equal(drained, 0, 'the SDK stream must not be advanced after the consumer left')
})

test('a model Ollama has not pulled ends in one readable error, not a reply (real CLI sequence)', async (t) => {
  const env = testEnv(t, { OLLAMA_HOST: 'http://127.0.0.1:11434' })
  const q = failingQuery("There's an issue with the selected model (no-such-model:latest). It may not exist or you may not have access to it.")
  const events = await collect(runBot({ ...BASE, model: 'ollama/no-such-model:latest' }, { query: q.fn, env, probeOllama: ollamaUp }))
  assert.deepEqual(events, [
    { type: 'session', sessionId: 's-fail' },
    { type: 'error', message: "no-such-model:latest isn't pulled. Run `ollama pull no-such-model:latest`.", kind: 'other' },
  ])
})

test('Ollama going away mid-run ends in one readable error (real CLI sequence)', async (t) => {
  const env = testEnv(t, { OLLAMA_HOST: 'http://127.0.0.1:11434' })
  const q = failingQuery('API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)')
  const events = await collect(runBot({ ...BASE, model: 'ollama/qwq:latest' }, { query: q.fn, env, probeOllama: ollamaUp }))
  assert.deepEqual(events.filter((e) => e.type === 'error'), [
    { type: 'error', message: "Ollama isn't answering at http://127.0.0.1:11434. Start it with `ollama serve`.", kind: 'other' },
  ])
  assert.equal(events.some((e) => e.type === 'result'), false)
})

test('an Ollama that does not answer the probe fails fast, before the CLI is spawned', async (t) => {
  const env = testEnv(t, { OLLAMA_HOST: 'http://127.0.0.1:11434' })
  const q = recordingQuery([])
  let probed = ''
  const events = await collect(runBot(
    { ...BASE, model: 'ollama/qwq:latest' },
    { query: q.fn, env, probeOllama: async (host) => { probed = host; return ollamaDown() } },
  ))
  assert.equal(probed, 'http://127.0.0.1:11434')
  assert.deepEqual(events, [{ type: 'error', message: "Ollama isn't answering at http://127.0.0.1:11434. Start it with `ollama serve`.", kind: 'other' }])
  assert.equal(q.calls(), 0)
})

test('an Anthropic run never probes Ollama', async (t) => {
  let probed = false
  const q = recordingQuery([{ type: 'result', subtype: 'success', session_id: 's', result: 'hi', total_cost_usd: 0, num_turns: 1 }])
  await collect(runBot(BASE, { query: q.fn, env: testEnv(t, { ANTHROPIC_API_KEY: 'k' }), probeOllama: async () => { probed = true; return true } }))
  assert.equal(probed, false)
})

test('a key the Anthropic API rejects ends in one error with the rejected-key message', async (t) => {
  const q = failingQuery('Invalid API key · Fix external API key')
  const events = await collect(runBot(BASE, { query: q.fn, env: testEnv(t, { ANTHROPIC_API_KEY: 'sk-ant-wrong' }) }))
  assert.deepEqual(events.filter((e) => e.type === 'error'), [{ type: 'error', message: REJECTED_API_KEY, kind: 'auth' }])
})

test('other CLI failures keep their text, without the CLI product name', async (t) => {
  const env = testEnv(t, { ANTHROPIC_API_KEY: 'k' })
  const q = failingQuery("There's an issue with the selected model (claude-nope). It may not exist or you may not have access to it.")
  const events = await collect(runBot({ ...BASE, model: 'claude-nope' }, { query: q.fn, env }))
  const errors = events.filter((e) => e.type === 'error')
  assert.equal(errors.length, 1)
  assert.equal(errors[0]?.type === 'error' && errors[0].message, "There's an issue with the selected model (claude-nope). It may not exist or you may not have access to it.")

  const thrown = (() => {
    throw new Error('Claude Code native binary not found at /app/x/claude. Please ensure Claude Code is installed via native installer or specify a valid path with options.pathToClaudeCodeExecutable.')
  }) as unknown as QueryFn
  const [spawnFailure] = await collect(runBot(BASE, { query: thrown, env }))
  assert.ok(spawnFailure?.type === 'error')
  assert.doesNotMatch(spawnFailure.message, /claude[ -]?code/i)
  assert.match(spawnFailure.message, /native binary not found at \/app\/x\/claude/)
})

test('a run that stops at its turn or budget limit says so in words', async (t) => {
  const env = testEnv(t, { ANTHROPIC_API_KEY: 'k' })
  for (const [subtype, expected] of [['error_max_turns', /BOT_MAX_TURNS/], ['error_max_budget_usd', /BOT_MAX_BUDGET_USD/]] as const) {
    const q = recordingQuery([{ type: 'result', subtype, is_error: true, session_id: 's', errors: [], total_cost_usd: 0, num_turns: 12 }])
    const events = await collect(runBot(BASE, { query: q.fn, env }))
    const [error] = events.filter((e) => e.type === 'error')
    assert.ok(error?.type === 'error')
    assert.match(error.message, expected)
  }
})

test('the Ollama explanations only fire on Ollama connection and missing-model failures', () => {
  const qwq = { provider: 'ollama' as const, sdkModel: 'qwq:latest' }
  assert.equal(explainOllamaFailure('MCP server "opendots" failed to connect', qwq, 'http://h'), 'MCP server "opendots" failed to connect')
  assert.equal(explainOllamaFailure('client disconnected', qwq, 'http://h'), 'client disconnected')
  assert.equal(
    explainOllamaFailure('Native CLI binary for linux-arm64 not found. Reinstall the SDK.', qwq, 'http://h'),
    'Native CLI binary for linux-arm64 not found. Reinstall the SDK.',
  )
  assert.equal(explainOllamaFailure('fetch failed', qwq, 'http://h'), "Ollama isn't answering at http://h. Start it with `ollama serve`.")
  assert.equal(
    explainOllamaFailure('{"type":"not_found_error","message":"model \'qwq:latest\' not found"}', qwq, 'http://h'),
    "qwq:latest isn't pulled. Run `ollama pull qwq:latest`.",
  )
})

test('mapSdkMessage treats a success result flagged is_error as an error, never as the answer', () => {
  const events = mapSdkMessage(
    { type: 'result', subtype: 'success', is_error: true, session_id: 's', result: 'API Error: 500', total_cost_usd: 0, num_turns: 1 } as unknown as SDKMessage,
    new Map(),
  )
  assert.deepEqual(events, [{ type: 'error', message: 'API Error: 500', kind: 'other' }])
})
