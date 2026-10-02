import { NextResponse } from 'next/server'
import { assertHostGrant } from '@/lib/auth/viewer'
import { browserFor } from '@/lib/browser/agent-browser'
import { asViewer } from '@/lib/http/as-viewer'

interface RouteContext {
  params: Promise<{ channelUrl: string }>
}

/** Switches the bot's browser between headless and a visible window, on the server's screen: operators only. */
export async function PATCH(request: Request, { params }: RouteContext) {
  return asViewer(async ({ viewer, repo }) => {
    const { channelUrl } = await params
    assertHostGrant(viewer, "show a bot's browser window")
    const body = (await request.json().catch(() => null)) as { headed?: unknown } | null
    if (!body || typeof body.headed !== 'boolean') {
      return NextResponse.json({ error: 'Field "headed" must be a boolean', code: 'INVALID_BODY' }, { status: 400 })
    }
    const channel = await repo.getChannel(channelUrl)
    if (!channel?.assistant) return NextResponse.json({ error: 'No bot here', code: 'NO_ASSISTANT' }, { status: 404 })
    const updated = await repo.updateAssistant(channelUrl, { ...channel.assistant, browser: { headed: body.headed } })
    // The running session keeps its mode; close it so the next open relaunches. Login state persists via --session-name.
    await browserFor(channelUrl).close()
    return NextResponse.json({ channel: updated })
  })
}
