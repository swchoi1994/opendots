import { NextResponse } from 'next/server'
import { asViewer } from '@/lib/http/as-viewer'

interface RouteContext {
  params: Promise<{ channelUrl: string }>
}

export async function POST(_request: Request, { params }: RouteContext) {
  return asViewer(async ({ repo }) => {
    const { channelUrl } = await params
    return NextResponse.json({ channel: await repo.markRead(channelUrl) })
  })
}
