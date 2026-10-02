import { NextResponse } from 'next/server'
import type { ChatRepository } from '@/lib/repository/chat-repository'
import { getAiConfig } from '@/lib/ai/config'
import { RetrieverNotConfiguredError, getRetriever } from '@/lib/ai/rag/retriever'
import { asViewer } from '@/lib/http/as-viewer'

/** Searches the built-in corpus and the viewer's workspace documents. */
export async function GET(request: Request) {
  return asViewer(({ repo }) => search(request, repo))
}

async function search(request: Request, repo: ChatRepository): Promise<Response> {
  const query = new URL(request.url).searchParams.get('q')

  if (!query || query.trim().length === 0) {
    return NextResponse.json(
      { error: 'Query parameter "q" is required', code: 'MISSING_QUERY' },
      { status: 400 },
    )
  }

  const config = getAiConfig()
  if (!config.rag.enabled) {
    return NextResponse.json({ error: 'RAG is disabled', code: 'RAG_DISABLED' }, { status: 503 })
  }

  try {
    const retriever = await getRetriever(config, repo)
    const results = await retriever.retrieve(query.trim())
    return NextResponse.json({
      query: query.trim(),
      vectorStore: config.rag.vectorStore,
      topK: config.rag.topK,
      results,
    })
  } catch (error) {
    if (error instanceof RetrieverNotConfiguredError) {
      return NextResponse.json(
        { error: error.message, code: 'RETRIEVER_NOT_CONFIGURED' },
        { status: 503 },
      )
    }
    throw error
  }
}
