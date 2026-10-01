import { parseAvatar, type BotAvatar } from './avatar'
import { DEFAULT_MODEL_ID } from './models'

/**
 * Per-bot configuration.
 *
 * A bot is a conversation whose `assistant` is non-null. The field keeps the
 * name `assistant` because every route and both stores speak it; what changed
 * is the shape: a bot has a name, an avatar, a role prompt, and a tool grant
 * set that maps onto Agent SDK tools (see ai/tools/grants.ts).
 */

export type ToolName = 'rag_search' | 'channel_history' | 'files' | 'shell' | 'skills' | 'web_browser'

export interface ToolDescriptor {
  id: ToolName
  label: string
  description: string
  /** False for tools that are listed but not grantable yet (later phases). */
  available: boolean
}

export const TOOL_CATALOG: ToolDescriptor[] = [
  {
    id: 'rag_search',
    label: 'Knowledge search',
    description: 'Search uploaded knowledge and the built-in corpus before answering.',
    available: true,
  },
  {
    id: 'channel_history',
    label: 'Conversation history',
    description: 'Read the whole thread as context.',
    available: true,
  },
  {
    id: 'files',
    label: 'Files',
    description:
      'Read, write, and search files inside the bot\'s own workspace. Paths outside it are refused, and the bot can\'t change its own configuration files.',
    available: true,
  },
  {
    id: 'skills',
    label: 'Find and install skills',
    description: 'Search skills.sh and install a skill into the workspace when a task needs it.',
    available: true,
  },
  {
    id: 'shell',
    label: 'Terminal',
    description:
      'Run shell commands as the server user, starting in the bot\'s workspace; not sandboxed. Grant with care.',
    available: true,
  },
  {
    id: 'web_browser',
    label: 'Browser',
    description: 'Operate a real browser in its own session; every action is screenshotted into the timeline.',
    available: true,
  },
]

export const SHELL_BROWSER_WARNING =
  'This bot can browse the web and run commands on this computer. A web page could tell it to run commands. Turn both on only for sites you trust.'

/** Browser + Terminal is the combination a web page can turn into commands on the host. */
export function shellBrowserWarning(tools: readonly ToolName[]): string | null {
  return tools.includes('shell') && tools.includes('web_browser') ? SHELL_BROWSER_WARNING : null
}

export interface MemoryConfig {
  enabled: boolean
  /**
   * Recent messages replayed as turns when a bot starts a FRESH session. A
   * resumed session already holds its history, so the window is skipped then.
   */
  windowMessages: number
}

export const DEFAULT_MEMORY: MemoryConfig = { enabled: true, windowMessages: 10 }

export interface GuardrailConfig {
  enabled: boolean
  maxInputChars: number
  blockSecrets: boolean
  flagInjection: boolean
}

export const DEFAULT_GUARDRAILS: GuardrailConfig = {
  enabled: true,
  maxInputChars: 4000,
  blockSecrets: true,
  flagInjection: true,
}

export interface BrowserConfig {
  /** Run with a visible window instead of headless; the runner forwards this to browser_open. */
  headed: boolean
}

export const DEFAULT_BROWSER: BrowserConfig = { headed: false }

export interface AssistantConfig {
  /** `default`, `ollama/<name>`, or an Anthropic API model id (see domain/models.ts). */
  model: string
  /** Display name of the bot, e.g. "Chief of Staff". */
  name: string
  avatar: BotAvatar
  /** The role prompt. The planner appends the shared operating preamble. */
  systemMessage: string
  tools: ToolName[]
  memory: MemoryConfig
  guardrails: GuardrailConfig
  /** Uploaded knowledge documents scoped to this bot. */
  skillIds: string[]
  browser: BrowserConfig
}

export const DEFAULT_ASSISTANT: AssistantConfig = {
  model: DEFAULT_MODEL_ID,
  name: 'Assistant',
  avatar: { shape: 'blob', color: 'violet' },
  systemMessage: 'You are a helpful teammate in a team chat. Be concise and specific.',
  tools: ['rag_search', 'channel_history', 'files', 'skills', 'web_browser'],
  memory: DEFAULT_MEMORY,
  guardrails: DEFAULT_GUARDRAILS,
  skillIds: [],
  browser: DEFAULT_BROWSER,
}

export function isToolName(value: unknown): value is ToolName {
  return TOOL_CATALOG.some((tool) => tool.id === value)
}

/** Grantable now: listed AND available. */
export function isGrantableTool(value: unknown): value is ToolName {
  return TOOL_CATALOG.some((tool) => tool.id === value && tool.available)
}

/**
 * Coerces untrusted input into a valid config, falling back per field. Also
 * upgrades rows written before bots had a name or avatar.
 */
export function parseAssistantConfig(input: unknown, fallbackName?: string): AssistantConfig {
  const raw = (input ?? {}) as Partial<Record<keyof AssistantConfig, unknown>>

  const model =
    typeof raw.model === 'string' && raw.model.trim().length > 0
      ? raw.model.trim()
      : DEFAULT_ASSISTANT.model
  const name =
    typeof raw.name === 'string' && raw.name.trim().length > 0
      ? raw.name.trim()
      : (fallbackName?.trim() || DEFAULT_ASSISTANT.name)
  const avatar = parseAvatar(raw.avatar, name)
  const systemMessage =
    typeof raw.systemMessage === 'string' && raw.systemMessage.trim().length > 0
      ? raw.systemMessage.trim()
      : DEFAULT_ASSISTANT.systemMessage
  const tools = Array.isArray(raw.tools) ? raw.tools.filter(isGrantableTool) : DEFAULT_ASSISTANT.tools
  const skillIds = Array.isArray(raw.skillIds)
    ? raw.skillIds.filter((id): id is string => typeof id === 'string')
    : []

  const rawMemory = (raw.memory ?? {}) as Partial<MemoryConfig>
  const windowMessages =
    typeof rawMemory.windowMessages === 'number' && Number.isFinite(rawMemory.windowMessages)
      ? Math.min(50, Math.max(2, Math.floor(rawMemory.windowMessages)))
      : DEFAULT_MEMORY.windowMessages
  const memory: MemoryConfig = {
    enabled: typeof rawMemory.enabled === 'boolean' ? rawMemory.enabled : DEFAULT_MEMORY.enabled,
    windowMessages,
  }

  const rawGuardrails = (raw.guardrails ?? {}) as Partial<GuardrailConfig>
  const guardrails: GuardrailConfig = {
    enabled:
      typeof rawGuardrails.enabled === 'boolean' ? rawGuardrails.enabled : DEFAULT_GUARDRAILS.enabled,
    maxInputChars:
      typeof rawGuardrails.maxInputChars === 'number' && Number.isFinite(rawGuardrails.maxInputChars)
        ? Math.min(32_000, Math.max(200, Math.floor(rawGuardrails.maxInputChars)))
        : DEFAULT_GUARDRAILS.maxInputChars,
    blockSecrets:
      typeof rawGuardrails.blockSecrets === 'boolean'
        ? rawGuardrails.blockSecrets
        : DEFAULT_GUARDRAILS.blockSecrets,
    flagInjection:
      typeof rawGuardrails.flagInjection === 'boolean'
        ? rawGuardrails.flagInjection
        : DEFAULT_GUARDRAILS.flagInjection,
  }

  const rawBrowser = (raw.browser ?? {}) as Partial<BrowserConfig>
  const browser: BrowserConfig = {
    headed: typeof rawBrowser.headed === 'boolean' ? rawBrowser.headed : DEFAULT_BROWSER.headed,
  }

  return { model, name, avatar, systemMessage, tools, memory, guardrails, skillIds, browser }
}
