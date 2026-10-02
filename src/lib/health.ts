import { describeAiConfig } from './ai/config'
import { buildModelOptions as catalogOptions } from './ai/model-catalog'
import { DEFAULT_MODEL_ID, OLLAMA_PREFIX } from './domain/models'
import type { ChannelSummary } from './domain/types'
import { describeStore, getRepository } from './repository'

/**
 * What is actually wired up: the brain, the models this server can run, the
 * store, and plain-language advice for anything missing. Probes Ollama with a
 * 1.5 s timeout, so it stays inside the container healthcheck's 3 s.
 *
 * A store that cannot answer (a locked or corrupt data directory, an
 * unreachable Postgres) makes the report 503 "degraded", so the container
 * healthcheck sees a dead database instead of a cheerful "ok".
 */

export interface HealthDeps {
  /** The viewer's workspace listing; defaults to the local workspace's. */
  listChannels?: () => Promise<ChannelSummary[]>
  /** Test seam; defaults to asking Ollama and checking ANTHROPIC_API_KEY. */
  buildModelOptions?: typeof catalogOptions
}

export async function buildHealth(
  deps: HealthDeps = {},
): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const catalog = await (deps.buildModelOptions ?? catalogOptions)()

  let channels: ChannelSummary[] = []
  let storeError: string | null = null
  try {
    channels = await (deps.listChannels ?? (() => getRepository().listChannels()))()
  } catch (cause) {
    storeError = cause instanceof Error ? cause.message : String(cause)
  }

  const botModels = channels
    .flatMap((channel) => (channel.assistant ? [channel.assistant.model] : []))
    .map((model) => (model === DEFAULT_MODEL_ID ? catalog.defaultModel : model))
  const usable = catalog.options.some((option) => option.provider !== 'default' && option.available)
  const advice = [
    ...(storeError ? [`The data store is not answering: ${storeError}`] : []),
    ...(usable
      ? []
      : ['No model is usable yet. Set ANTHROPIC_API_KEY, or start Ollama and pull a model that supports tools (https://ollama.com/search?c=tools).']),
    ...(botModels.some((model) => model.startsWith(OLLAMA_PREFIX))
      ? ['Some bots run on Ollama. Raise its context window or long chats get cut off: OLLAMA_CONTEXT_LENGTH=32768 ollama serve']
      : []),
  ]

  return {
    httpStatus: storeError ? 503 : 200,
    body: {
      status: storeError ? 'degraded' : 'ok',
      service: 'opendots',
      ai: describeAiConfig(),
      models: {
        default: catalog.defaultModel,
        usable,
        ollama: { ...catalog.ollama, toolModels: catalog.options.filter((option) => option.provider === 'ollama').length },
      },
      store: { ...describeStore(), ...(storeError ? { error: storeError } : {}) },
      advice,
    },
  }
}

/**
 * For a signed-out request in Clerk mode: whether the store answers, for a
 * load balancer or a container healthcheck, and nothing about the setup. The
 * probe reads document ids rather than listing channels, because a listing
 * would seed starter bots into a workspace nobody is using.
 */
export async function buildBriefHealth(
  probe: () => Promise<unknown> = () => getRepository().listSkillIds(),
): Promise<{ httpStatus: number; body: { status: string; service: string } }> {
  try {
    await probe()
    return { httpStatus: 200, body: { status: 'ok', service: 'opendots' } }
  } catch {
    return { httpStatus: 503, body: { status: 'degraded', service: 'opendots' } }
  }
}
