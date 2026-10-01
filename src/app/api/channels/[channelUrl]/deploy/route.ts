import { NextResponse } from 'next/server'
import { RepositoryError } from '@/lib/repository/chat-repository'
import { getRepository } from '@/lib/repository'

interface RouteContext {
  params: Promise<{ channelUrl: string }>
}

export async function POST(request: Request, { params }: RouteContext) {
  const { channelUrl } = await params

  try {
    const deployment = await getRepository().deployChannel(channelUrl)
    // Build the share link from the request's own origin so it is correct
    // whatever host and port the app is actually served on.
    const origin = new URL(request.url).origin

    return NextResponse.json({
      deployment,
      url: `${origin}/app/${deployment.id}`,
    })
  } catch (error) {
    if (error instanceof RepositoryError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    throw error
  }
}
