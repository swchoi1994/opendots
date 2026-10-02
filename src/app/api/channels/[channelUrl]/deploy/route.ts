import { NextResponse } from 'next/server'
import { asViewer } from '@/lib/http/as-viewer'

interface RouteContext {
  params: Promise<{ channelUrl: string }>
}

export async function POST(request: Request, { params }: RouteContext) {
  return asViewer(async ({ repo }) => {
    const { channelUrl } = await params
    const deployment = await repo.deployChannel(channelUrl)
    // Build the share link from the request's own origin so it is correct
    // whatever host and port the app is actually served on.
    const origin = new URL(request.url).origin

    return NextResponse.json({
      deployment,
      url: `${origin}/app/${deployment.id}`,
    })
  })
}
