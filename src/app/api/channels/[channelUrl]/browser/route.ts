import { NextResponse } from 'next/server'
import { browserFor } from '@/lib/browser/agent-browser'
import { RepositoryError } from '@/lib/repository/chat-repository'
import { getRepository } from '@/lib/repository'

interface RouteContext {
  params: Promise<{ channelUrl: string }>
}

/** Switches the bot's browser between headless and a visible window. */
export async function PATCH(request: Request, { params }: RouteContext) {
  const { channelUrl } = await params
  const body = (await request.json().catch(() => null)) as { headed?: unknown } | null
  if (!body || typeof body.headed !== 'boolean') {
    return NextResponse.json({ error: 'Field "headed" must be a boolean', code: 'INVALID_BODY' }, { status: 400 })
  }
  const channel = await getRepository().getChannel(channelUrl)
  if (!channel?.assistant) return NextResponse.json({ error: 'No bot here', code: 'NO_ASSISTANT' }, { status: 404 })
  try {
    const updated = await getRepository().updateAssistant(channelUrl, { ...channel.assistant, browser: { headed: body.headed } })
    // The running session keeps its mode; close it so the next open relaunches. Login state persists via --session-name.
    await browserFor(channelUrl).close()
    return NextResponse.json({ channel: updated })
  } catch (error) {
    if (error instanceof RepositoryError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    throw error
  }
}
