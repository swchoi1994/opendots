import type { AssistantConfig, ToolName } from '../../domain/assistant'
import { getAiConfig } from '../config'
import { getRetriever, type RetrievedChunk } from '../rag/retriever'
import { toolGrants, type ToolGrants } from '../tools/grants'

/**
 * The planner: everything about a bot turn that does NOT need the model.
 *
 * Retrieval, prompt assembly, tool grants, memory policy, and the trace all
 * happen here, deterministically, which is what makes the golden set able to
 * assert configuration without credentials. `runBotTurn` feeds the plan to the
 * brain; the eval feeds it to the evaluators.
 */

export interface TraceEntry {
  node: string
  detail: string
}

export interface Provenance {
  /** The bot's slug; kept under the historical name `route`. */
  route: string
  usedSkills: { id: string; title: string; source: string }[]
  usedBuiltInKnowledge: boolean
}

export interface MemoryTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface PlanBotTurnInput {
  question: string
  channelUrl: string | null
  transcript: string
  /** Recent turns, oldest first, excluding the question itself. */
  memory: MemoryTurn[]
  bot: AssistantConfig
  /** Null means every uploaded document; an array scopes to those ids. */
  skillIds: string[] | null
  /** True when an SDK session will be resumed, so history need not be replayed. */
  hasSession: boolean
  /**
   * Tools the caller withholds regardless of the bot's own grants — the
   * share-link path uses it so an untrusted visitor cannot reach the host.
   */
  restrictedTools?: ToolName[]
}

export interface BotTurnPlan {
  route: string
  model: string
  systemPrompt: string
  prompt: string
  grants: ToolGrants
  memoryTurns: number
  context: RetrievedChunk[]
  provenance: Provenance
  trace: TraceEntry[]
  dryRunAnswer: string
}

const SKILL_SOURCE_PREFIX = 'skill/'

export function provenanceFrom(route: string, context: RetrievedChunk[]): Provenance {
  const skills = new Map<string, { id: string; title: string; source: string }>()
  let usedBuiltInKnowledge = false
  for (const chunk of context) {
    if (chunk.source.startsWith(SKILL_SOURCE_PREFIX)) {
      skills.set(chunk.documentId, { id: chunk.documentId, title: chunk.title, source: chunk.source })
    } else {
      usedBuiltInKnowledge = true
    }
  }
  return { route, usedSkills: [...skills.values()], usedBuiltInKnowledge }
}

export function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'bot'
}

export const OPENDOTS_PREAMBLE = [
  'You are a named teammate inside OpenDots, a team chat where each bot is a persistent coworker.',
  'You work in your own workspace folder; files you create there persist between turns.',
  'When a task needs a capability you lack, use find_skill and install_skill to add a skill, then tell the user it will be active next turn.',
  'When a task needs the web, use browser_open, read the returned elements, act on @refs with a truthful one-line intent, and call browser_snapshot after navigation; every action is screenshotted for the user automatically.',
  'Be concise. Prefer acting over asking; ask only when a wrong assumption would be costly.',
].join(' ')

export async function planBotTurn(input: PlanBotTurnInput): Promise<BotTurnPlan> {
  const { bot } = input
  const config = getAiConfig()
  const trace: TraceEntry[] = []
  const node = slugify(bot.name)

  /*
   * What the bot is actually allowed this turn: its own grants, minus anything
   * the caller withholds (a share-link visitor), minus rag_search when the
   * environment has knowledge search off. Grants are computed from this list,
   * so a tool that is off here is never named in `allowedTools` either.
   */
  const restricted = input.restrictedTools ?? []
  const withheld = restricted.filter((tool) => bot.tools.includes(tool))
  const tools = bot.tools.filter((tool) => !restricted.includes(tool) && (tool !== 'rag_search' || config.rag.enabled))
  const grants = toolGrants(tools)
  if (withheld.length > 0) {
    trace.push({ node, detail: `tools withheld for share-link visitor: ${withheld.join(', ')}` })
  }

  let context: RetrievedChunk[] = []
  if (tools.includes('rag_search')) {
    const retriever = await getRetriever(config)
    context = await retriever.retrieve(input.question, { skillIds: input.skillIds ?? undefined })
    trace.push({ node, detail: `rag_search via ${config.rag.vectorStore}: ${context.length} passage(s)` })
  } else if (bot.tools.includes('rag_search') && !config.rag.enabled) {
    trace.push({ node, detail: 'rag_search disabled by environment' })
  } else {
    trace.push({ node, detail: 'rag_search disabled by conversation config' })
  }

  const transcript = tools.includes('channel_history') ? input.transcript : ''
  if (tools.includes('channel_history')) {
    trace.push({ node, detail: `channel_history: ${input.transcript.length} char(s) of transcript` })
  } else {
    trace.push({ node, detail: 'channel_history disabled by conversation config' })
  }

  let memoryTurns = 0
  let memoryBlock = ''
  if (!bot.memory.enabled) {
    trace.push({ node, detail: 'short-term memory disabled by conversation config' })
  } else if (input.hasSession) {
    trace.push({ node, detail: 'session resumed: memory replay skipped' })
  } else {
    // `slice(-0)` is `slice(0)` — the whole array — so a zero window has to be
    // special-cased or it would replay everything it was meant to suppress.
    const window = bot.memory.windowMessages > 0 ? input.memory.slice(-bot.memory.windowMessages) : []
    memoryTurns = window.length
    trace.push({ node, detail: `short-term memory: ${memoryTurns} turn(s)` })
    if (memoryTurns > 0) {
      memoryBlock = `Recent conversation (oldest first):\n${window.map((t) => `${t.role}: ${t.content}`).join('\n')}\n`
    }
  }

  const systemPrompt = `${bot.systemMessage.trim()}\n\n${OPENDOTS_PREAMBLE}`

  const contextBlock = context.length
    ? context.map((c, i) => `[${i + 1}] ${c.title} (${c.source})\n${c.text}`).join('\n\n')
    : '(no passages retrieved up front; use search_knowledge if the question needs it)'

  const prompt = [
    memoryBlock,
    transcript ? `Full conversation:\n${transcript}\n` : '',
    `Retrieved knowledge:\n${contextBlock}\n`,
    `Question: ${input.question}`,
  ]
    .filter(Boolean)
    .join('\n')

  trace.push({ node, detail: `tools granted: ${grants.all.length > 0 ? grants.all.join(', ') : 'none'}` })
  trace.push({ node, detail: `planned generation with ${bot.model}` })

  const dryRunAnswer = [
    `[dry run] ${bot.name} would answer with Claude (${bot.provider}), but the brain is in dry-run mode, so no model was called.`,
    '',
    `Model that would be used: ${bot.model}`,
    `Tools granted: ${grants.all.length > 0 ? grants.all.join(', ') : 'none'}`,
    `System message: ${systemPrompt.slice(0, 160)}${systemPrompt.length > 160 ? '…' : ''}`,
    '',
    context.length > 0
      ? `Retrieved ${context.length} passage(s):\n${context.map((c, i) => `  ${i + 1}. ${c.title} — ${c.source} (${c.score.toFixed(3)})`).join('\n')}`
      : 'Retrieved no passages.',
  ].join('\n')

  return {
    route: node,
    model: bot.model,
    systemPrompt,
    prompt,
    grants,
    memoryTurns,
    context,
    provenance: provenanceFrom(node, context),
    trace,
    dryRunAnswer,
  }
}
