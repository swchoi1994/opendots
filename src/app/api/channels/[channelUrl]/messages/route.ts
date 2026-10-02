import { NextResponse } from 'next/server'
import { checkInput } from '@/lib/ai/guardrails/policies'
import { asViewer } from '@/lib/http/as-viewer'

interface RouteContext {
  // Next 16 delivers dynamic segments asynchronously.
  params: Promise<{ channelUrl: string }>
}

export async function GET(_request: Request, { params }: RouteContext) {
  return asViewer(async ({ repo }) => {
    const { channelUrl } = await params
    const messages = await repo.listMessages(channelUrl)

    if (messages === null) {
      return NextResponse.json(
        { error: `No channel with url "${channelUrl}"`, code: 'CHANNEL_NOT_FOUND' },
        { status: 404 },
      )
    }

    return NextResponse.json({ messages })
  })
}

export async function POST(request: Request, { params }: RouteContext) {
  return asViewer(async ({ repo }) => {
    const { channelUrl } = await params

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Body must be valid JSON', code: 'INVALID_JSON' },
        { status: 400 },
      )
    }

    const text = (body as { message?: unknown })?.message
    if (typeof text !== 'string') {
      return NextResponse.json(
        { error: 'Field "message" must be a string', code: 'INVALID_BODY' },
        { status: 400 },
      )
    }

    /*
     * Input guardrails run BEFORE the message is stored. Checking after would
     * mean a blocked credential is already sitting in the transcript, which is
     * exactly the outcome the policy exists to prevent.
     */
    const channelForGuard = await repo.getChannel(channelUrl)
    if (channelForGuard?.assistant) {
      const verdict = checkInput(text, channelForGuard.assistant.guardrails)
      if (verdict.action === 'block') {
        return NextResponse.json(
          {
            error: 'Message blocked by guardrails',
            code: 'GUARDRAIL_BLOCKED',
            findings: verdict.findings,
          },
          { status: 422 },
        )
      }
    }

    const message = await repo.sendMessage(channelUrl, text)

    // The assistant's reply is produced by the streaming /respond endpoint, so
    // this route stays fast and the client can paint the sent message at once.
    const channel = await repo.getChannel(channelUrl)
    const expectsReply = Boolean(channel?.assistant)

    return NextResponse.json({ message, expectsReply }, { status: 201 })
  })
}
