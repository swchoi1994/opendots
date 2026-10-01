import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { AssistantConfig, ToolName } from '../../domain/assistant'
import type { Screen } from '../../domain/screen'
import { isUserMessage, type Message } from '../../domain/types'
import { browserFor } from '../../browser/agent-browser'
import { getRepository } from '../../repository'
import type { ChatRepository } from '../../repository/chat-repository'
import { workspaceFor } from '../../bots/workspace'
import { DEFAULT_MODEL_ID } from '../../domain/models'
import { MISSING_API_KEY, runBot, type BotErrorKind } from '../brain'
import { resolveDefaultModel } from '../model-catalog'
import { getAiConfig } from '../config'
import { checkOutput, type GuardrailAction, type GuardrailFinding } from '../guardrails/policies'
import type { RetrievedChunk } from '../rag/retriever'
import type { ScreenCapture } from '../tools/browser-tools'
import { createOpenDotsServer } from '../tools/opendots-mcp'
import { planBotTurn, provenanceFrom, type MemoryTurn, type Provenance, type TraceEntry } from './bot-turn'

/**
 * One bot turn, end to end: load the thread, plan, run the brain (or the dry
 * run), apply output guardrails, persist the reply and the session id.
 *
 * Deliberately trigger-agnostic and free of `Request`: the HTTP respond route
 * calls it today; Phase 3 schedules and event triggers call the same function.
 */

/**
 * Who or what started this turn. `deployment_visitor` is the only untrusted
 * one: anybody holding a share link and its passcode, which is why the runner
 * withholds the tools that reach the host from it.
 */
export type TurnTrigger = 'user_message' | 'schedule' | 'event' | 'deployment_visitor'

/**
 * Never granted on a turn a share-link visitor drove.
 *
 * `files`, `shell` and `skills` reach the host filesystem directly. `web_browser`
 * is here for the same reason once removed: it drives the bot's own persistent
 * browser session — its cookies, its logged-in sites — so granting it would let
 * anyone holding a share link steer an authenticated browser on the host.
 */
export const VISITOR_RESTRICTED_TOOLS: ToolName[] = ['files', 'shell', 'skills', 'web_browser']

export class TurnError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'TurnError'
  }
}

export interface TurnContext {
  channelUrl: string
  assistant: AssistantConfig
  question: string
  transcript: string
  memory: MemoryTurn[]
  sessionId: string | null
  trigger: TurnTrigger
}

export type TurnEvent =
  | { type: 'provenance'; provenance: Provenance }
  | { type: 'trace'; trace: TraceEntry[] }
  | { type: 'token'; token: string }
  | { type: 'tool_start'; name: string; summary: string }
  | { type: 'tool_result'; name: string; ok: boolean; summary: string }
  | { type: 'skill_installed'; skill: string }
  | { type: 'screen'; screen: Screen }
  | { type: 'guardrail'; stage: 'output'; action: GuardrailAction; findings: GuardrailFinding[] }
  | { type: 'done'; message: Message }
  | { type: 'error'; error: string; kind: BotErrorKind; message: Message | null }

/** Persists one browser-tool capture as a `Screen`, scoped to the turn it happened in. */
export async function persistScreen(
  repo: ChatRepository,
  channelUrl: string,
  turnId: string,
  capture: ScreenCapture,
): Promise<Screen> {
  return repo.appendScreen({ channelUrl, turnId, ...capture })
}

function isBotSender(userId: string): boolean {
  return userId.startsWith('bot_') || userId === 'user_assistant'
}

export async function loadTurnContext(
  channelUrl: string,
  trigger: TurnTrigger = 'user_message',
): Promise<TurnContext> {
  const repo = getRepository()
  const channel = await repo.getChannel(channelUrl)
  if (!channel) throw new TurnError(`No channel with url "${channelUrl}"`, 'CHANNEL_NOT_FOUND', 404)
  if (!channel.assistant) throw new TurnError('This conversation has no bot configured', 'NO_ASSISTANT', 400)

  const thread = (await repo.listMessages(channelUrl)) ?? []
  const last = [...thread].reverse().find(({ message }) => isUserMessage(message) && !isBotSender(message.sender.userId))
  if (!last || !isUserMessage(last.message)) throw new TurnError('Nothing to respond to', 'NO_QUESTION', 400)

  const window = channel.assistant.memory.enabled ? channel.assistant.memory.windowMessages : 0
  // `slice(-0)` is `slice(0)` — the whole array — so a zero window has to be
  // special-cased or disabling memory would replay everything.
  const memory: MemoryTurn[] =
    window === 0
      ? []
      : thread
          .filter(({ message }) => isUserMessage(message))
          .slice(0, -1)
          .slice(-window)
          .map(({ message }) => ({
            role: isBotSender(message.sender.userId) ? 'assistant' : 'user',
            content: isUserMessage(message) ? message.message : '',
          }))

  const transcript = thread
    .map(({ message }) =>
      isUserMessage(message)
        ? `${message.sender.nickname}: ${message.message}`
        : `${message.sender.nickname} sent a file (${message.name})`,
    )
    .join('\n')

  return {
    channelUrl,
    assistant: channel.assistant,
    question: last.message.message,
    transcript,
    memory,
    sessionId: await repo.getBotSession(channelUrl),
    trigger,
  }
}

const DRY_RUN_CHUNK = /[\s\S]{1,18}/g
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function* runBotTurn(
  ctx: TurnContext,
  opts: { signal?: AbortSignal } = {},
  deps: {
    runBot?: typeof runBot
    /**
     * Test-only seam: receives the exact `onScreen` callback this run hands to the
     * browser tools, so a fake brain can simulate a mid-turn capture without a real
     * browser. Called only when this turn actually built a browser context, so a
     * test can assert a restricted turn never gets one. Never set outside tests.
     */
    onBrowserHook?: (hook: (capture: ScreenCapture) => Promise<void>) => void
    /** Resolves the `default` model id; tests pin it instead of probing Ollama. */
    resolveDefaultModel?: () => Promise<string>
  } = {},
): AsyncGenerator<TurnEvent> {
  const repo = getRepository()
  const config = getAiConfig()
  const { assistant, channelUrl } = ctx
  const run = deps.runBot ?? runBot
  const turnId = randomBytes(6).toString('hex')
  const pendingScreens: Screen[] = []

  try {
    const plan = await planBotTurn({
      question: ctx.question,
      channelUrl,
      transcript: ctx.transcript,
      memory: ctx.memory,
      bot: assistant,
      skillIds: assistant.skillIds,
      hasSession: ctx.sessionId !== null,
      restrictedTools: ctx.trigger === 'deployment_visitor' ? VISITOR_RESTRICTED_TOOLS : [],
    })
    const trace: TraceEntry[] = [...plan.trace]
    const retrieved: RetrievedChunk[] = [...plan.context]
    const installed: string[] = []

    yield { type: 'provenance', provenance: plan.provenance }

    let answer = ''
    let failure: { message: string; kind: BotErrorKind } | null = null

    if (config.brain.dryRun) {
      // Chunked with a delay so the streaming path is exercised without a brain;
      // emitted back to back React would batch it into a single paint.
      for (const piece of plan.dryRunAnswer.match(DRY_RUN_CHUNK) ?? []) {
        answer += piece
        yield { type: 'token', token: piece }
        await sleep(30)
      }
    } else {
      const workspaceDir = workspaceFor(channelUrl)
      const model =
        assistant.model === DEFAULT_MODEL_ID
          ? await (deps.resolveDefaultModel ?? resolveDefaultModel)()
          : assistant.model
      if (model !== assistant.model) trace.push({ node: plan.route, detail: `default model resolved to ${model}` })
      const onScreen = async (capture: ScreenCapture) => {
        const screen = await persistScreen(repo, channelUrl, turnId, capture).catch((error) => {
          // A frame that cannot be stored must never fail the browsing turn, but
          // silence here reads as "the bot took no screenshots" — most often it
          // means the `screens` table is missing (`pnpm db:init`).
          console.warn('[screens] persist failed', error instanceof Error ? error.message : error)
          return null
        })
        if (screen) pendingScreens.push(screen)
      }
      // Grants, not the raw tool list: `web_browser` is in VISITOR_RESTRICTED_TOOLS,
      // so a share-link visitor's plan carries no `browser_*` grant and this turn
      // therefore builds no browser context at all.
      const browser = plan.grants.mcp.some((name) => name.startsWith('mcp__opendots__browser_'))
        ? {
            client: browserFor(channelUrl),
            screensDir: join(workspaceDir, '.screens', turnId),
            onScreen,
            headed: assistant.browser?.headed ?? false,
          }
        : undefined
      if (browser) deps.onBrowserHook?.(onScreen)
      const server = createOpenDotsServer({
        skillIds: assistant.skillIds,
        workspaceDir,
        onRetrieved: (chunks) => retrieved.push(...chunks),
        onSkillInstalled: (skill) => installed.push(skill),
        browser,
      })

      let resume: string | null = ctx.sessionId
      for (let attempt = 0; attempt < 2; attempt++) {
        let newSessionId: string | null = null
        failure = null
        answer = ''

        for await (const event of run(
          {
            model,
            systemPrompt: plan.systemPrompt,
            prompt: plan.prompt,
            sessionId: resume,
            workspaceDir,
            builtinTools: plan.grants.builtins,
            allowedTools: plan.grants.all,
            mcpServers: { opendots: server },
            maxTurns: config.brain.maxTurns,
            ...(config.brain.maxBudgetUsd ? { maxBudgetUsd: config.brain.maxBudgetUsd } : {}),
            signal: opts.signal,
          },
          {},
        )) {
          switch (event.type) {
            case 'text':
              answer += event.delta
              yield { type: 'token', token: event.delta }
              break
            case 'tool_start':
            case 'tool_result':
              yield event
              break
            case 'session':
              newSessionId = event.sessionId
              break
            case 'result':
              newSessionId = event.sessionId
              // Streaming deltas can be lost if the SDK skipped partial messages.
              if (!answer && event.text) {
                answer = event.text
                yield { type: 'token', token: event.text }
              }
              trace.push({
                node: plan.route,
                detail: `completed in ${event.turns} turn(s), ${event.costUsd === null ? 'local' : `$${event.costUsd.toFixed(4)}`}`,
              })
              break
            case 'error':
              failure = { message: event.message, kind: event.kind }
              break
          }
          while (installed.length > 0) yield { type: 'skill_installed', skill: installed.shift()! }
          while (pendingScreens.length > 0) yield { type: 'screen', screen: pendingScreens.shift()! }
        }
        // Defensive: catches a capture the generator queued after its final
        // yielded event but before it actually finished iterating.
        while (pendingScreens.length > 0) yield { type: 'screen', screen: pendingScreens.shift()! }

        if (failure?.kind === 'session_not_found' && resume) {
          trace.push({ node: plan.route, detail: `session ${resume} not found, starting fresh` })
          await repo.clearBotSession(channelUrl)
          resume = null
          continue
        }
        if (newSessionId) await repo.setBotSession(channelUrl, newSessionId)
        break
      }
    }

    yield { type: 'trace', trace }

    if (failure && !answer) {
      const detail = failure.kind === 'usage_limit'
        ? 'The model provider reported a rate or usage limit. Try again later.'
        : failure.kind === 'auth' && failure.message !== MISSING_API_KEY
          ? 'The Anthropic API rejected ANTHROPIC_API_KEY. Check the key, then restart OpenDots.'
          : failure.message
      const stored = await repo.appendAssistantMessage(channelUrl, `[assistant error] ${detail}`).catch(() => null)
      yield { type: 'error', error: detail, kind: failure.kind, message: stored }
      return
    }

    const verdict = checkOutput(answer, assistant.guardrails)
    if (verdict.findings.length > 0) {
      yield { type: 'guardrail', stage: 'output', action: verdict.action, findings: verdict.findings }
    }

    const provenance = provenanceFrom(plan.route, retrieved)
    const text = failure ? `${verdict.text}\n\n[stopped early: ${failure.message}]` : verdict.text
    const stored = await repo.appendAssistantMessage(channelUrl, text, provenance)
    await repo.attachScreensToMessage(channelUrl, turnId, stored.messageId).catch(() => undefined)
    yield { type: 'provenance', provenance }
    yield { type: 'done', message: stored }
  } catch (cause) {
    /*
     * Anything the brain-failure branch above does not cover: a planner throw
     * (RetrieverNotConfiguredError), a repository write that fails, a bug. The
     * user's message is already in the thread, so a silent close would read as
     * the bot ignoring them — persist the failure in-thread instead.
     *
     * A consumer that breaks out of this generator (a disconnected client)
     * closes it with a return completion, which skips this catch by design.
     */
    const detail = cause instanceof Error ? cause.message : 'Bot failed to reply'
    const stored = await repo.appendAssistantMessage(channelUrl, `[assistant error] ${detail}`).catch(() => null)
    yield { type: 'error', error: detail, kind: 'other', message: stored }
  }
}
