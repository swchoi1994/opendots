import { NextResponse } from 'next/server'
import { parseAssistantConfig } from '@/lib/domain/assistant'
import { RepositoryError } from '@/lib/repository/chat-repository'
import { getRepository } from '@/lib/repository'

interface RouteContext {
  params: Promise<{ channelUrl: string }>
}

export async function GET(_request: Request, { params }: RouteContext) {
  const { channelUrl } = await params
  const channel = await getRepository().getChannel(channelUrl)

  if (!channel) {
    return NextResponse.json(
      { error: `No channel with url "${channelUrl}"`, code: 'CHANNEL_NOT_FOUND' },
      { status: 404 },
    )
  }

  return NextResponse.json({ channel })
}

/** Replaces the assistant configuration on an existing conversation. */
export async function PATCH(request: Request, { params }: RouteContext) {
  const { channelUrl } = await params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Body must be valid JSON', code: 'INVALID_JSON' }, { status: 400 })
  }

  const { assistant } = (body ?? {}) as { assistant?: unknown }
  if (assistant === undefined) {
    return NextResponse.json(
      { error: 'Field "assistant" is required', code: 'INVALID_BODY' },
      { status: 400 },
    )
  }

  const repo = getRepository()
  // Loaded first so the existing name is the fallback when an edit omits it —
  // otherwise a partial PATCH would silently rename the bot to "Assistant".
  const channel = await repo.getChannel(channelUrl)
  if (!channel) {
    return NextResponse.json(
      { error: `No channel with url "${channelUrl}"`, code: 'CHANNEL_NOT_FOUND' },
      { status: 404 },
    )
  }

  try {
    // Same coercion as creation, so an edit cannot write a shape that creation
    // would have rejected. The store carries the name onto the channel row too,
    // so a rename shows up in the sidebar and not only in the bot panel.
    const updated = await repo.updateAssistant(channelUrl, parseAssistantConfig(assistant, channel.name))
    return NextResponse.json({ channel: updated })
  } catch (error) {
    if (error instanceof RepositoryError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    throw error
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const { channelUrl } = await params

  try {
    await getRepository().deleteChannel(channelUrl)
    return NextResponse.json({ deleted: channelUrl })
  } catch (error) {
    if (error instanceof RepositoryError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    throw error
  }
}
