import { NextResponse } from 'next/server'
import { describeAiConfig } from '@/lib/ai/config'
import { buildModelOptions } from '@/lib/ai/model-catalog'
import { DEFAULT_MODEL_ID, OLLAMA_PREFIX } from '@/lib/domain/models'
import { describeStore, getRepository } from '@/lib/repository'

/**
 * What is actually wired up: the brain, the models this server can run, the
 * store, and plain-language advice for anything missing. Probes Ollama with a
 * 1.5 s timeout, so it stays inside the container healthcheck's 3 s.
 */
export async function GET() {
  const catalog = await buildModelOptions()
  const channels = await getRepository().listChannels().catch(() => [])
  const botModels = channels
    .flatMap((channel) => (channel.assistant ? [channel.assistant.model] : []))
    .map((model) => (model === DEFAULT_MODEL_ID ? catalog.defaultModel : model))
  const usable = catalog.options.some((option) => option.provider !== 'default' && option.available)
  const advice = [
    ...(usable
      ? []
      : ['No model is usable yet. Set ANTHROPIC_API_KEY, or start Ollama and pull a model that supports tools (https://ollama.com/search?c=tools).']),
    ...(botModels.some((model) => model.startsWith(OLLAMA_PREFIX))
      ? ['Some bots run on Ollama. Raise its context window or long chats get cut off: OLLAMA_CONTEXT_LENGTH=32768 ollama serve']
      : []),
  ]

  return NextResponse.json({
    status: 'ok',
    service: 'opendots',
    ai: describeAiConfig(),
    models: {
      default: catalog.defaultModel,
      usable,
      ollama: { ...catalog.ollama, toolModels: catalog.options.filter((option) => option.provider === 'ollama').length },
    },
    store: describeStore(),
    advice,
  })
}
