import { buildRespondStream } from '@/lib/ai/respond-stream'
import { asViewer } from '@/lib/http/as-viewer'

interface RouteContext {
  params: Promise<{ channelUrl: string }>
}

/** Streams the assistant's reply for the latest message in a conversation. */
export async function POST(_request: Request, { params }: RouteContext) {
  return asViewer(async ({ repo }) => {
    const { channelUrl } = await params
    return buildRespondStream(channelUrl, 'user_message', repo.scope)
  })
}
