import { buildRespondStream } from '@/lib/ai/respond-stream'

interface RouteContext {
  params: Promise<{ channelUrl: string }>
}

/** Streams the assistant's reply for the latest message in a conversation. */
export async function POST(_request: Request, { params }: RouteContext) {
  const { channelUrl } = await params
  return buildRespondStream(channelUrl)
}
