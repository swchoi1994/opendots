import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { NextResponse } from 'next/server'
import { asViewer } from '@/lib/http/as-viewer'

interface RouteContext {
  params: Promise<{ channelUrl: string; screenId: string }>
}

/** Serves a frame's JPEG. Only paths the repository returned are ever read. */
export async function GET(_request: Request, { params }: RouteContext) {
  return asViewer(async ({ repo }) => {
    const { channelUrl, screenId } = await params
    const id = Number.parseInt(screenId, 10)
    if (!Number.isFinite(id)) {
      return NextResponse.json({ error: 'Bad screen id', code: 'INVALID_ID' }, { status: 400 })
    }
    const path = await repo.getScreenImagePath(channelUrl, id)
    if (!path) return NextResponse.json({ error: 'No such screen', code: 'SCREEN_NOT_FOUND' }, { status: 404 })
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return NextResponse.json({ error: 'Image file missing', code: 'IMAGE_MISSING' }, { status: 410 })
    }
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
      headers: {
        'content-type': 'image/jpeg',
        'content-length': String(size),
        'cache-control': 'private, max-age=31536000, immutable',
      },
    })
  })
}
