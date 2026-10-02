import { NextResponse } from 'next/server'
import { assertAdmin } from '@/lib/auth/viewer'
import { asViewer } from '@/lib/http/as-viewer'

interface RouteContext {
  params: Promise<{ skillId: string }>
}

/** Removes a knowledge document from the workspace. Every bot that searched it loses it, so admins only. */
export async function DELETE(_request: Request, { params }: RouteContext) {
  return asViewer(async ({ viewer, repo }) => {
    const { skillId } = await params
    assertAdmin(viewer, 'delete a document')
    await repo.deleteSkill(skillId)
    return NextResponse.json({ deleted: skillId })
  })
}
