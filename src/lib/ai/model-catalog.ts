import { CLAUDE_MODELS, DEFAULT_MODEL_ID, OLLAMA_PREFIX, type ModelOption } from '../domain/models'

/**
 * What models this server can run right now: Claude when ANTHROPIC_API_KEY is
 * set, plus whatever tools-capable models the local Ollama has pulled. Also
 * decides what the `default` model id means for a turn starting now.
 */

export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434'

/**
 * OLLAMA_HOST is shared with the Ollama server, where it is a bind address
 * ("0.0.0.0", "127.0.0.1:11500"), so a bare host and a wildcard address are
 * turned into a URL a client can call. Never throws: a malformed value is
 * passed through and simply shows up as unreachable.
 */
export function ollamaHost(env: Partial<NodeJS.ProcessEnv> = process.env): string {
  const raw = (env.OLLAMA_HOST ?? '').trim()
  if (!raw) return DEFAULT_OLLAMA_HOST
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`)
    if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1'
    if (!url.port && url.protocol === 'http:') url.port = '11434'
    return url.origin
  } catch {
    return raw
  }
}

export interface OllamaModel {
  name: string
  /** Ollama reports a `tools` capability; every bot turn may call tools. */
  tools: boolean
}

/** Local models, or null when Ollama does not answer. */
export async function listOllamaModels(
  host: string = ollamaHost(),
  fetchFn: typeof fetch = fetch,
  timeoutMs = 1500,
): Promise<OllamaModel[] | null> {
  try {
    const response = await fetchFn(`${host}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return null
    const body = (await response.json()) as { models?: { name?: unknown; capabilities?: unknown }[] }
    return (body.models ?? []).flatMap((model) =>
      typeof model.name === 'string'
        ? [{ name: model.name, tools: Array.isArray(model.capabilities) && model.capabilities.includes('tools') }]
        : [],
    )
  } catch {
    return null
  }
}

export interface CatalogDeps {
  env?: Partial<NodeJS.ProcessEnv>
  /** Test seam; defaults to asking the configured Ollama. */
  listModels?: () => Promise<OllamaModel[] | null>
}

/** The concrete model a bot set to `default` runs on for a turn starting now. */
export async function resolveDefaultModel(deps: CatalogDeps = {}): Promise<string> {
  const env = deps.env ?? process.env
  const configured = env.OPENDOTS_DEFAULT_MODEL?.trim()
  if (configured && configured !== DEFAULT_MODEL_ID) return configured
  if (env.ANTHROPIC_API_KEY) return 'sonnet'
  const local = await (deps.listModels ?? (() => listOllamaModels(ollamaHost(env))))()
  const pick = local?.find((model) => model.tools)
  return pick ? `${OLLAMA_PREFIX}${pick.name}` : 'sonnet'
}

/** The picker's options, the resolved default, and whether Ollama answered. */
export async function buildModelOptions(deps: CatalogDeps = {}): Promise<{
  options: ModelOption[]
  defaultModel: string
  ollama: { host: string; reachable: boolean }
}> {
  const env = deps.env ?? process.env
  const host = ollamaHost(env)
  // One probe, shared by the default resolution and the list.
  const local = await (deps.listModels ?? (() => listOllamaModels(host)))()
  const defaultModel = await resolveDefaultModel({ env, listModels: async () => local })
  const keySet = Boolean(env.ANTHROPIC_API_KEY)
  const options: ModelOption[] = [
    { id: DEFAULT_MODEL_ID, label: `Default (${defaultModel})`, provider: 'default', available: true },
    ...CLAUDE_MODELS.map((model) => ({ ...model, available: keySet })),
    ...(local ?? [])
      .filter((model) => model.tools)
      .map((model) => ({
        id: `${OLLAMA_PREFIX}${model.name}`,
        label: `${model.name} (local)`,
        provider: 'ollama' as const,
        available: true,
      })),
  ]
  return { options, defaultModel, ollama: { host, reachable: local !== null } }
}
