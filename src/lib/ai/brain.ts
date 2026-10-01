import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  query as sdkQuery,
  type McpServerConfig,
  type Options,
  type PermissionResult,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { dataDir } from '../data-dir'
import { resolveModel, type ResolvedModel } from '../domain/models'
import { brainEnv } from './brain-env'
import { ollamaHost } from './model-catalog'
import { workspaceGuardHook } from './tools/workspace-guard'

/**
 * The brain: one Agent SDK run per bot turn, on Claude through the Anthropic
 * API or on a local model through Ollama's Anthropic-compatible endpoint.
 *
 * The model id decides the provider (domain/models.ts) and brain-env.ts
 * decides what the CLI subprocess may see. This module knows nothing about
 * channels or storage: it turns one prompt into a stream of BotEvents.
 */

export type BotErrorKind = 'usage_limit' | 'auth' | 'aborted' | 'session_not_found' | 'other'

export type BotEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; name: string; summary: string }
  | { type: 'tool_result'; name: string; ok: boolean; summary: string }
  | { type: 'session'; sessionId: string }
  /** `costUsd` is null for local models: the CLI cannot price a model it does not know. */
  | { type: 'result'; text: string; sessionId: string; costUsd: number | null; turns: number }
  | { type: 'error'; message: string; kind: BotErrorKind }

export interface BotRunInput {
  /** A concrete model id. `default` is resolved by the caller (run-bot-turn.ts). */
  model: string
  systemPrompt: string
  prompt: string
  /** Resume this SDK session when set; a fresh session otherwise. */
  sessionId: string | null
  /** The bot's working directory. Skills under `.claude/skills/` load from here. */
  workspaceDir: string
  /** Built-in tools that exist for this run (Read, Bash, ...). */
  builtinTools: string[]
  /** Everything auto-approved: built-ins plus `mcp__opendots__*` names. */
  allowedTools: string[]
  mcpServers?: Record<string, McpServerConfig>
  maxTurns: number
  maxBudgetUsd?: number
  signal?: AbortSignal
}

export const MISSING_API_KEY = 'Set ANTHROPIC_API_KEY, or switch this bot to an Ollama model.'
export const REJECTED_API_KEY = 'The Anthropic API rejected ANTHROPIC_API_KEY. Check the key, then restart OpenDots.'

export function ollamaDownMessage(host: string): string {
  return `Ollama isn't answering at ${host}. Start it with \`ollama serve\`.`
}

export interface BrainStatus {
  mode: 'live' | 'dry-run'
  anthropic: { keySet: boolean; customBaseUrl: boolean }
  ollama: { host: string }
}

export function describeBrain(env: Partial<NodeJS.ProcessEnv> = process.env): BrainStatus {
  return {
    mode: env.BRAIN_DRY_RUN === '1' ? 'dry-run' : 'live',
    anthropic: { keySet: Boolean(env.ANTHROPIC_API_KEY), customBaseUrl: Boolean(env.ANTHROPIC_BASE_URL) },
    ollama: { host: ollamaHost(env) },
  }
}

/**
 * Ollama failures surface as generic connection or not-found text; say what to
 * do instead. The CLI reports a model Ollama does not have as "There's an
 * issue with the selected model (…)", and a refused connection, after about
 * three minutes of retries, as "API Error: Connection refused … (ECONNREFUSED)".
 */
export function explainOllamaFailure(message: string, resolved: ResolvedModel, host: string): string {
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND|fetch failed|connection error|connection refused|unable to connect|socket hang up/i.test(message)) {
    return ollamaDownMessage(host)
  }
  if (/issue with the selected model|not_found_error|model\b[^.]{0,80}\bnot found|\b404\b/i.test(message)) {
    return `${resolved.sdkModel} isn't pulled. Run \`ollama pull ${resolved.sdkModel}\`.`
  }
  return message
}

/**
 * The SDK wraps a failed run as "Claude Code returned an error result: …" and
 * names its CLI in other errors too. That is the SDK's product, not ours, and
 * user-facing copy never uses the name: drop the wrapper, name the rest
 * generically.
 */
export function withoutCliName(text: string): string {
  return text
    .replace(/claude[ -]?code returned an error result:\s*/gi, '')
    .replace(/claude[ -]?code/gi, (_match, offset: number, whole: string) =>
      offset === 0 || /[.!?]\s*$/.test(whole.slice(0, offset)) ? 'The agent runtime' : 'the agent runtime',
    )
}

/** Result subtypes that carry no text of their own. */
const RESULT_SUBTYPE_TEXT: Record<string, string> = {
  error_max_turns: 'The bot used all its tool-use rounds for this reply (BOT_MAX_TURNS) before it finished.',
  error_max_budget_usd: 'The bot reached its spending limit for this reply (BOT_MAX_BUDGET_USD) before it finished.',
  error_during_execution: 'The bot stopped because of an error while it was working.',
}

/** The one readable message a failed run ends with, by provider. */
export function readableFailure(event: { message: string; kind: BotErrorKind }, resolved: ResolvedModel, host: string): string {
  const text = withoutCliName(event.message)
  if (resolved.provider === 'anthropic') {
    return event.kind === 'auth' && event.message !== MISSING_API_KEY ? REJECTED_API_KEY : text
  }
  return event.kind === 'other' ? explainOllamaFailure(text, resolved, host) : text
}

/** Whether Ollama answers at all, so a stopped Ollama fails in a second instead of after minutes of CLI retries. */
export async function ollamaReachable(host: string, fetchFn: typeof fetch = fetch, timeoutMs = 1500): Promise<boolean> {
  try {
    const response = await fetchFn(`${host}/api/version`, { signal: AbortSignal.timeout(timeoutMs) })
    return response.ok
  } catch {
    return false
  }
}

export function classifyError(text: string): BotErrorKind {
  if (/no conversation found|session[^.]{0,40}not found|could not resume/i.test(text)) return 'session_not_found'
  if (/rate.?limit|usage limit|exceeded your|\b429\b|quota/i.test(text)) return 'usage_limit'
  if (/not logged in|unauthori[sz]ed|\b401\b|authentication|invalid api key|please run \/login/i.test(text)) return 'auth'
  if (/abort/i.test(text)) return 'aborted'
  return 'other'
}

const SUMMARY_MAX = 120

export function summarizeToolInput(name: string, input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>
  // Prefer the argument a human would recognise: query, command, path, ref.
  const key = ['query', 'command', 'file_path', 'path', 'pattern', 'ref', 'url'].find((k) => typeof record[k] === 'string')
  const value = key ? String(record[key]) : JSON.stringify(record)
  const text = `${name.replace(/^mcp__opendots__/, '')}: ${value}`
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block && typeof block === 'object' && 'text' in block ? String((block as { text: unknown }).text) : ''))
    .join('')
}

export function mapSdkMessage(message: SDKMessage, pendingTools: Map<string, string>): BotEvent[] {
  switch (message.type) {
    case 'system':
      return message.subtype === 'init' ? [{ type: 'session', sessionId: message.session_id }] : []

    case 'stream_event': {
      if (message.parent_tool_use_id) return [] // subagent output stays internal
      const event = message.event as { type: string; delta?: { type: string; text?: string } }
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        return [{ type: 'text', delta: event.delta.text }]
      }
      return []
    }

    case 'assistant': {
      if (message.parent_tool_use_id) return []
      const events: BotEvent[] = []
      for (const block of message.message.content as unknown as { type: string; id?: string; name?: string; input?: unknown }[]) {
        if (block.type === 'tool_use' && block.id && block.name) {
          pendingTools.set(block.id, block.name)
          events.push({ type: 'tool_start', name: block.name, summary: summarizeToolInput(block.name, block.input) })
        }
      }
      return events
    }

    case 'user': {
      if (message.parent_tool_use_id) return []
      const content = message.message.content
      if (!Array.isArray(content)) return []
      const events: BotEvent[] = []
      for (const block of content as unknown as { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue
        const name = pendingTools.get(block.tool_use_id) ?? 'tool'
        pendingTools.delete(block.tool_use_id)
        const summary = textOf(block.content).replace(/\s+/g, ' ').trim()
        events.push({
          type: 'tool_result',
          name,
          ok: !block.is_error,
          summary: summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 1)}…` : summary,
        })
      }
      return events
    }

    case 'result': {
      // The real CLI reports most failures (a model it cannot use, a refused
      // connection, a rejected key) as subtype 'success' with is_error set and
      // the error text as `result` — never the answer.
      if (message.subtype === 'success' && !message.is_error) {
        return [{
          type: 'result',
          text: message.result,
          sessionId: message.session_id,
          costUsd: message.total_cost_usd,
          turns: message.num_turns,
        }]
      }
      const errors = message.subtype === 'success' ? [message.result] : (message as { errors?: unknown }).errors
      const listed = Array.isArray(errors) ? errors.map(String).map((e) => e.trim()).filter(Boolean).join('; ') : ''
      const text = listed || RESULT_SUBTYPE_TEXT[message.subtype] || message.subtype
      return [{ type: 'error', message: text, kind: classifyError(text) }]
    }

    default:
      return []
  }
}

export type QueryFn = typeof sdkQuery

export async function* runBot(
  input: BotRunInput,
  deps: {
    query?: QueryFn
    env?: Partial<NodeJS.ProcessEnv>
    /** Test seam: whether Ollama answers at `host`. Defaults to a 1.5 s probe of /api/version. */
    probeOllama?: (host: string) => Promise<boolean>
  } = {},
): AsyncGenerator<BotEvent> {
  const query = deps.query ?? sdkQuery
  const source = deps.env ?? process.env

  let resolved: ResolvedModel
  try {
    resolved = resolveModel(input.model)
  } catch (cause) {
    yield { type: 'error', message: cause instanceof Error ? cause.message : String(cause), kind: 'other' }
    return
  }
  // No fallback to a claude.ai login: without a key an Anthropic model cannot run.
  if (resolved.provider === 'anthropic' && !source.ANTHROPIC_API_KEY) {
    yield { type: 'error', message: MISSING_API_KEY, kind: 'auth' }
    return
  }

  const host = ollamaHost(source)
  // Without this a stopped Ollama costs about three minutes of silent CLI retries.
  if (resolved.provider === 'ollama' && !(await (deps.probeOllama ?? ollamaReachable)(host))) {
    yield { type: 'error', message: ollamaDownMessage(host), kind: 'other' }
    return
  }

  const root = dataDir(source)
  mkdirSync(join(root, 'claude'), { recursive: true })

  const abortController = new AbortController()
  input.signal?.addEventListener('abort', () => abortController.abort(), { once: true })
  let stderrTail = ''

  const canUseTool = async (toolName: string): Promise<PermissionResult> =>
    input.allowedTools.includes(toolName)
      ? { behavior: 'allow' }
      : {
          behavior: 'deny',
          message: `Tool "${toolName}" is not granted to this bot. Continue without it, or tell the user which tool you need.`,
        }

  const options: Options = {
    model: resolved.sdkModel,
    systemPrompt: input.systemPrompt,
    cwd: input.workspaceDir,
    // Replaces the subprocess environment outright — the SDK does not merge it.
    env: brainEnv(resolved, source, root),
    resume: input.sessionId ?? undefined,
    persistSession: true,
    // Loads <workspace>/.claude/* — settings and installed skills.
    settingSources: ['project'],
    tools: input.builtinTools,
    allowedTools: input.allowedTools,
    permissionMode: 'default',
    canUseTool,
    // Hooks run before allow rules, so this also covers tools in allowedTools,
    // which never reach canUseTool.
    hooks: { PreToolUse: [{ hooks: [workspaceGuardHook(input.workspaceDir)] }] },
    mcpServers: input.mcpServers,
    includePartialMessages: true,
    maxTurns: input.maxTurns,
    ...(input.maxBudgetUsd ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
    abortController,
    stderr: (data) => {
      stderrTail = (stderrTail + data).slice(-2000)
    },
  }

  const pendingTools = new Map<string, string>()
  /*
   * A run ends in at most one error. After a failed result the SDK also throws
   * ("… returned an error result: <the same text>") when the CLI exits; that
   * throw restates the failure already reported, so it is swallowed.
   */
  let failed = false
  try {
    for await (const message of query({ prompt: input.prompt, options })) {
      for (const event of mapSdkMessage(message, pendingTools)) {
        if (event.type === 'error') {
          if (failed) continue
          failed = true
          yield { ...event, message: readableFailure(event, resolved, host) }
        } else {
          yield event.type === 'result' && resolved.provider === 'ollama' ? { ...event, costUsd: null } : event
        }
      }
    }
  } catch (cause) {
    if (!failed) {
      const text = cause instanceof Error ? cause.message : String(cause)
      // The CLI's own diagnostic lines ("[claude-code:unrecognized_model] …", logged on every
      // local-model run) say nothing to a user.
      const stderr = stderrTail.split('\n').filter((line) => !/^\[claude[ -]?code:/i.test(line.trim())).join('\n').trim()
      const detail = [text, stderr].filter(Boolean).join('\n')
      const kind = input.signal?.aborted ? 'aborted' : classifyError(detail)
      yield { type: 'error', message: readableFailure({ message: detail, kind }, resolved, host), kind }
    }
  } finally {
    // Runs on the normal path AND when a consumer closes the generator early
    // (a disconnected client). Without it the CLI subprocess would keep working
    // — and keep spending API usage — for a reply nobody will read.
    abortController.abort()
  }
}
