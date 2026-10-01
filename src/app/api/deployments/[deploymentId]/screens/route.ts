import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { deploymentImageUrl } from '@/lib/domain/screen'
import { cookieNameFor, verifySession } from '@/lib/deployment-session'
import { getRepository } from '@/lib/repository'

interface RouteContext {
  params: Promise<{ deploymentId: string }>
}

/**
 * Deployment-scoped listing, for the thumbnails a share-link visitor sees.
 *
 * A visitor sees only frames belonging to messages in the deployed thread:
 * frames are attached to a reply (`messageId`) when the turn stores it, so an
 * unattached frame is from a turn still in flight and is withheld. The channel
 * comes from the deployment, never from the request, and every returned
 * `imageUrl` is rewritten to the deployment-scoped image route so a visitor
 * never receives a channel-scoped URL they could poke at unlocked.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { deploymentId } = await params

  const deployment = await getRepository().getDeployment(deploymentId)
  if (!deployment) {
    return NextResponse.json({ error: 'Not found', code: 'DEPLOYMENT_NOT_FOUND' }, { status: 404 })
  }

  const jar = await cookies()
  const token = jar.get(cookieNameFor(deploymentId))?.value
  if (!verifySession(token, deploymentId, deployment.passcode)) {
    return NextResponse.json({ error: 'Locked', code: 'LOCKED' }, { status: 401 })
  }

  const search = new URL(request.url).searchParams
  const turnId = search.get('turnId') ?? undefined
  const limitRaw = Number.parseInt(search.get('limit') ?? '', 10)
  const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, limitRaw)) : 200
  const screens = await getRepository().listScreens(deployment.channelUrl, { turnId, limit })
  // channelUrl is dropped: a share-link visitor gets the deployment id and
  // nothing that would let them address the underlying channel directly.
  const rewritten = screens
    .filter((s) => s.messageId !== null)
    .map(({ channelUrl: _channelUrl, imageUrl, ...rest }) => ({
      ...rest,
      imageUrl: imageUrl ? deploymentImageUrl(deploymentId, rest.screenId) : null,
    }))
  return NextResponse.json({ screens: rewritten })
}
