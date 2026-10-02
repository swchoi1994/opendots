import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { cookieNameFor, verifySession } from '@/lib/deployment-session'
import { getRepository } from '@/lib/repository'
import { visitorScope } from '@/lib/repository/chat-repository'

interface RouteContext {
  params: Promise<{ deploymentId: string; screenId: string }>
}

/**
 * Serves a frame's JPEG for a deployment share-link visitor.
 *
 * A visitor sees only frames belonging to messages in the deployed thread, so
 * the lookup is `attachedOnly`: a frame from a turn still in flight (no
 * `messageId` yet) 404s here. Only paths the repository returned are ever
 * read, and the channel is derived from the deployment rather than accepted
 * from the request.
 */
export async function GET(_request: Request, { params }: RouteContext) {
  const { deploymentId, screenId } = await params

  const deployment = await getRepository().getDeployment(deploymentId)
  if (!deployment) {
    return NextResponse.json({ error: 'Not found', code: 'DEPLOYMENT_NOT_FOUND' }, { status: 404 })
  }

  const jar = await cookies()
  const token = jar.get(cookieNameFor(deploymentId))?.value
  if (!verifySession(token, deploymentId, deployment.passcode)) {
    return NextResponse.json({ error: 'Locked', code: 'LOCKED' }, { status: 401 })
  }

  // The channel's workspace, acting as this link's visitor: never the owner.
  const repo = getRepository(visitorScope(deployment))

  const id = Number.parseInt(screenId, 10)
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: 'Bad screen id', code: 'INVALID_ID' }, { status: 400 })
  }
  const path = await repo.getScreenImagePath(deployment.channelUrl, id, { attachedOnly: true })
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
      // Every view passes the passcode check: a cached frame would outlive a
      // locked link or a changed passcode in a shared browser.
      'cache-control': 'private, no-store',
    },
  })
}
