import { NextResponse } from 'next/server'
import { getViewer } from '@/lib/auth/server'
import { scopeFor, type Viewer } from '@/lib/auth/viewer'
import { buildBriefHealth, buildHealth } from '@/lib/health'
import { getRepository } from '@/lib/repository'

/**
 * See lib/health.ts: 200 "ok", or 503 "degraded" when the store cannot answer.
 * Public, so a signed-out caller in Clerk mode gets only `{ status, service }`;
 * a viewer gets the full report, read from their own workspace.
 */
export async function GET() {
  let viewer: Viewer | null
  try {
    viewer = await getViewer()
  } catch {
    // Signing in touches the store (the one-time claim); if that fails the store is the problem.
    viewer = null
  }
  if (!viewer) {
    const { httpStatus, body } = await buildBriefHealth()
    return NextResponse.json(body, { status: httpStatus })
  }
  const repo = getRepository(scopeFor(viewer))
  const { httpStatus, body } = await buildHealth({ listChannels: () => repo.listChannels() })
  return NextResponse.json(body, { status: httpStatus })
}
