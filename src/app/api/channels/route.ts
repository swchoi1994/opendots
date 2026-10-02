import { NextResponse } from 'next/server'
import { assertAdmin, assertConfigChange } from '@/lib/auth/viewer'
import { parseAssistantConfig } from '@/lib/domain/assistant'
import { asViewer } from '@/lib/http/as-viewer'

export async function GET() {
  return asViewer(async ({ repo }) => NextResponse.json({ channels: await repo.listChannels() }))
}

/** Creates an assistant conversation configured from the + dialog. */
export async function POST(request: Request) {
  return asViewer(async ({ viewer, repo }) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Body must be valid JSON', code: 'INVALID_JSON' },
        { status: 400 },
      )
    }

    const { name, assistant } = (body ?? {}) as { name?: unknown; assistant?: unknown }

    if (typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json(
        { error: 'Field "name" must be a non-empty string', code: 'INVALID_BODY' },
        { status: 400 },
      )
    }

    // parseAssistantConfig falls back per field, so a partial config still creates
    // a usable conversation instead of rejecting the whole request.
    const config = parseAssistantConfig(assistant, name)
    // A new bot counts as granting every tool it starts with.
    assertConfigChange(viewer, null, config)
    const channel = await repo.createChannel({ name, assistant: config })
    return NextResponse.json({ channel }, { status: 201 })
  })
}

/** Deletes every conversation in the workspace. Destructive, so admins only. */
export async function DELETE() {
  return asViewer(async ({ viewer, repo }) => {
    assertAdmin(viewer, 'delete every bot')
    return NextResponse.json({ deleted: await repo.deleteAllChannels() })
  })
}
