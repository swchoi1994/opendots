import { NextResponse } from 'next/server'
import { RepositoryError } from '@/lib/repository/chat-repository'
import { getRepository } from '@/lib/repository'

interface RouteContext {
  params: Promise<{ channelUrl: string }>
}

export async function POST(_request: Request, { params }: RouteContext) {
  const { channelUrl } = await params

  try {
    const channel = await getRepository().markRead(channelUrl)
    return NextResponse.json({ channel })
  } catch (error) {
    if (error instanceof RepositoryError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      )
    }
    throw error
  }
}
