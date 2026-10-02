import { NextResponse } from 'next/server'
import { buildHealth } from '@/lib/health'

/** See lib/health.ts: 200 "ok", or 503 "degraded" when the store cannot answer. */
export async function GET() {
  const { httpStatus, body } = await buildHealth()
  return NextResponse.json(body, { status: httpStatus })
}
