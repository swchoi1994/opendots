import { NextResponse } from 'next/server'
import { describeAiConfig } from '@/lib/ai/config'
import { describeStore } from '@/lib/repository'

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'opendots',
    ai: describeAiConfig(),
    store: describeStore(),
  })
}
