import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { cookieNameFor, verifySession } from '@/lib/deployment-session'
import { getRepository } from '@/lib/repository'
import { visitorScope } from '@/lib/repository/chat-repository'

interface RouteContext {
  params: Promise<{ deploymentId: string }>
}

export async function GET(_request: Request, { params }: RouteContext) {
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

  // The channel's workspace, acting as this link's visitor: never the owner.
  const repo = getRepository(visitorScope(deployment))

  const messages = await repo.listMessages(deployment.channelUrl)
  return NextResponse.json({ messages: messages ?? [] })
}
