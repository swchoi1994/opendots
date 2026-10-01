import { NextResponse } from 'next/server'
import { getRepository } from '@/lib/repository'

interface RouteContext {
  params: Promise<{ channelUrl: string }>
}

export async function GET(request: Request, { params }: RouteContext) {
  const { channelUrl } = await params
  if (!(await getRepository().getChannel(channelUrl))) {
    return NextResponse.json(
      { error: `No channel with url "${channelUrl}"`, code: 'CHANNEL_NOT_FOUND' },
      { status: 404 },
    )
  }
  const search = new URL(request.url).searchParams
  const turnId = search.get('turnId') ?? undefined
  const limitRaw = Number.parseInt(search.get('limit') ?? '', 10)
  const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, limitRaw)) : 200
  const screens = await getRepository().listScreens(channelUrl, { turnId, limit })
  return NextResponse.json({ screens })
}
