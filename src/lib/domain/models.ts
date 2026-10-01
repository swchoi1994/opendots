/**
 * A bot's `model` string decides which provider answers:
 *
 *   default          resolved by the server each turn (ai/model-catalog.ts)
 *   ollama/<name>    a local model served by Ollama
 *   anything else    a model behind the Anthropic API (sonnet, opus, haiku,
 *                    a full Claude id, or whatever ANTHROPIC_BASE_URL serves)
 *
 * Pure and dependency-free: the browser imports this for labels.
 */

export const DEFAULT_MODEL_ID = 'default'
export const OLLAMA_PREFIX = 'ollama/'

export type ProviderId = 'anthropic' | 'ollama'

export interface ResolvedModel {
  provider: ProviderId
  /** The model name the SDK sends: without the `ollama/` prefix. */
  sdkModel: string
}

export interface ModelOption {
  id: string
  label: string
  provider: ProviderId | 'default'
  /** False for Claude models while no ANTHROPIC_API_KEY is set. */
  available: boolean
}

export const CLAUDE_MODELS: ModelOption[] = [
  { id: 'sonnet', label: 'Claude Sonnet (balanced)', provider: 'anthropic', available: true },
  { id: 'opus', label: 'Claude Opus (deepest)', provider: 'anthropic', available: true },
  { id: 'haiku', label: 'Claude Haiku (fastest)', provider: 'anthropic', available: true },
]

/** What the picker shows before /api/models answers, or if it cannot. */
export const STATIC_MODEL_OPTIONS: ModelOption[] = [
  { id: DEFAULT_MODEL_ID, label: 'Default', provider: 'default', available: true },
  ...CLAUDE_MODELS,
]

export function resolveModel(model: string): ResolvedModel {
  const trimmed = model.trim()
  if (trimmed === DEFAULT_MODEL_ID) {
    throw new Error('resolveModel needs a concrete model id: resolve "default" first')
  }
  if (trimmed.startsWith(OLLAMA_PREFIX)) {
    const name = trimmed.slice(OLLAMA_PREFIX.length)
    if (!name) throw new Error('An Ollama model id needs a model name after "ollama/"')
    return { provider: 'ollama', sdkModel: name }
  }
  return { provider: 'anthropic', sdkModel: trimmed }
}

const CLAUDE_NAME = /^(sonnet|opus|haiku)$|^claude/i

/** Short label for a bot's model, e.g. "Ollama · qwq:latest". Never throws. */
export function modelBadge(model: string): string {
  const trimmed = model.trim()
  if (trimmed === DEFAULT_MODEL_ID) return 'Default model'
  if (trimmed.startsWith(OLLAMA_PREFIX)) return `Ollama · ${trimmed.slice(OLLAMA_PREFIX.length) || '?'}`
  return `${CLAUDE_NAME.test(trimmed) ? 'Claude' : 'API'} · ${trimmed}`
}
