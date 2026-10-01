import { NextResponse } from 'next/server'
import { RepositoryError } from '@/lib/repository/chat-repository'
import { getRepository } from '@/lib/repository'

interface RouteContext {
  params: Promise<{ skillId: string }>
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const { skillId } = await params

  try {
    await getRepository().deleteSkill(skillId)
    return NextResponse.json({ deleted: skillId })
  } catch (error) {
    if (error instanceof RepositoryError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    throw error
  }
}
