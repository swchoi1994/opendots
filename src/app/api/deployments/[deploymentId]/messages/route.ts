import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { checkInput } from '@/lib/ai/guardrails/policies'
import { cookieNameFor, verifySession } from '@/lib/deployment-session'
import { RepositoryError } from '@/lib/repository/chat-repository'
import { getRepository } from '@/lib/repository'

interface RouteContext {
  params: Promise<{ deploymentId: string }>
}

/**
 * Deployment-scoped posting.
 *
 * Separate from the channel endpoints on purpose: a visitor holding a share
 * link must never be able to address an arbitrary channelUrl, so the channel is
 * derived from the deployment rather than accepted from the request.
 */
export async function POST(request: Request, { params }: RouteContext) {
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

  if (!deployment.allowPosting) {
    return NextResponse.json(
      { error: 'This deployment is read-only', code: 'READ_ONLY' },
      { status: 403 },
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Body must be valid JSON', code: 'INVALID_JSON' }, { status: 400 })
  }

  const text = (body as { message?: unknown })?.message
  if (typeof text !== 'string') {
    return NextResponse.json(
      { error: 'Field "message" must be a string', code: 'INVALID_BODY' },
      { status: 400 },
    )
  }

  const channel = await getRepository().getChannel(deployment.channelUrl)
  if (channel?.assistant) {
    const verdict = checkInput(text, channel.assistant.guardrails)
    if (verdict.action === 'block') {
      return NextResponse.json(
        { error: 'Message blocked by guardrails', code: 'GUARDRAIL_BLOCKED', findings: verdict.findings },
        { status: 422 },
      )
    }
  }

  try {
    const message = await getRepository().sendMessage(deployment.channelUrl, text)
    return NextResponse.json({ message, expectsReply: Boolean(channel?.assistant) }, { status: 201 })
  } catch (error) {
    if (error instanceof RepositoryError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    throw error
  }
}
