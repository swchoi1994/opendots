import { NextResponse } from 'next/server'
import { cookieNameFor, passcodeMatches, signSession } from '@/lib/deployment-session'
import { getRepository } from '@/lib/repository'

interface RouteContext {
  params: Promise<{ deploymentId: string }>
}

export async function POST(request: Request, { params }: RouteContext) {
  const { deploymentId } = await params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Body must be valid JSON', code: 'INVALID_JSON' }, { status: 400 })
  }

  const passcode = (body as { passcode?: unknown })?.passcode
  if (typeof passcode !== 'string') {
    return NextResponse.json(
      { error: 'Field "passcode" must be a string', code: 'INVALID_BODY' },
      { status: 400 },
    )
  }

  const deployment = await getRepository().getDeployment(deploymentId)
  // Same response whether the deployment is missing or the passcode is wrong,
  // so the endpoint cannot be used to enumerate valid deployment ids.
  if (!deployment || !passcodeMatches(passcode, deployment.passcode)) {
    return NextResponse.json({ error: 'Incorrect passcode', code: 'INVALID_PASSCODE' }, { status: 401 })
  }

  const response = NextResponse.json({ ok: true })
  response.cookies.set({
    name: cookieNameFor(deploymentId),
    value: signSession(deploymentId, deployment.passcode),
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 12,
  })
  return response
}
