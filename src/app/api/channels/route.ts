import { NextResponse } from 'next/server'
import { parseAssistantConfig } from '@/lib/domain/assistant'
import { RepositoryError } from '@/lib/repository/chat-repository'
import { getRepository } from '@/lib/repository'

export async function GET() {
  const channels = await getRepository().listChannels()
  return NextResponse.json({ channels })
}

/** Creates an assistant conversation configured from the + dialog. */
export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: 'Body must be valid JSON', code: 'INVALID_JSON' },
      { status: 400 },
    )
  }

  const { name, assistant } = (body ?? {}) as { name?: unknown; assistant?: unknown }

  if (typeof name !== 'string' || name.trim().length === 0) {
    return NextResponse.json(
      { error: 'Field "name" must be a non-empty string', code: 'INVALID_BODY' },
      { status: 400 },
    )
  }

  try {
    // parseAssistantConfig falls back per field, so a partial config still creates
    // a usable conversation instead of rejecting the whole request.
    const channel = await getRepository().createChannel({
      name,
      assistant: parseAssistantConfig(assistant, name),
    })
    return NextResponse.json({ channel }, { status: 201 })
  } catch (error) {
    if (error instanceof RepositoryError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    throw error
  }
}

/** Deletes every conversation. Destructive and intentionally unconditional. */
export async function DELETE() {
  const deleted = await getRepository().deleteAllChannels()
  return NextResponse.json({ deleted })
}
