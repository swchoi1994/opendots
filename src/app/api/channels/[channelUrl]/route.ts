import { NextResponse } from 'next/server'
import { assertAdmin, assertConfigChange } from '@/lib/auth/viewer'
import { parseAssistantConfig } from '@/lib/domain/assistant'
import { asViewer } from '@/lib/http/as-viewer'

interface RouteContext {
  params: Promise<{ channelUrl: string }>
}

function notFound(channelUrl: string) {
  return NextResponse.json(
    { error: `No channel with url "${channelUrl}"`, code: 'CHANNEL_NOT_FOUND' },
    { status: 404 },
  )
}

export async function GET(_request: Request, { params }: RouteContext) {
  return asViewer(async ({ repo }) => {
    const { channelUrl } = await params
    const channel = await repo.getChannel(channelUrl)
    if (!channel) return notFound(channelUrl)
    return NextResponse.json({ channel })
  })
}

/** Replaces the assistant configuration on an existing conversation. */
export async function PATCH(request: Request, { params }: RouteContext) {
  return asViewer(async ({ viewer, repo }) => {
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

    // Loaded first so the existing name is the fallback when an edit omits it —
    // otherwise a partial PATCH would silently rename the bot to "Assistant".
    // It is also the stored grant a member's edit is measured against: never
    // the client's idea of what the bot had.
    const channel = await repo.getChannel(channelUrl)
    if (!channel) return notFound(channelUrl)

    // Same coercion as creation, so an edit cannot write a shape that creation
    // would have rejected. The store carries the name onto the channel row too,
    // so a rename shows up in the sidebar and not only in the bot panel.
    const config = parseAssistantConfig(assistant, channel.name)
    assertConfigChange(viewer, channel.assistant, config)
    const updated = await repo.updateAssistant(channelUrl, config)
    return NextResponse.json({ channel: updated })
  })
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  return asViewer(async ({ viewer, repo }) => {
    const { channelUrl } = await params
    assertAdmin(viewer, 'delete a bot')
    await repo.deleteChannel(channelUrl)
    return NextResponse.json({ deleted: channelUrl })
  })
}
