import { NextResponse } from 'next/server'
import { buildModelOptions } from '@/lib/ai/model-catalog'
import { asViewer } from '@/lib/http/as-viewer'

/** The model picker's options: Claude (when a key is set) and local Ollama models. */
export async function GET() {
  return asViewer(async () => {
    const { options, defaultModel } = await buildModelOptions()
    return NextResponse.json({ models: options, defaultModel })
  })
}
