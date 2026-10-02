import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { buildRespondStream } from '@/lib/ai/respond-stream'
import { cookieNameFor, verifySession } from '@/lib/deployment-session'
import { getRepository } from '@/lib/repository'
import { visitorScope } from '@/lib/repository/chat-repository'

interface RouteContext {
  params: Promise<{ deploymentId: string }>
}

export async function POST(_request: Request, { params }: RouteContext) {
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

  // The channel comes from the deployment, never from the request. The trigger
  // marks the turn untrusted: anyone with the link and passcode can drive it,
  // so files, shell, skills and the browser are withheld for the run.
  return buildRespondStream(deployment.channelUrl, 'deployment_visitor', visitorScope(deployment))
}
