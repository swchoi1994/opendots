import { NextResponse } from 'next/server'
import { asViewer } from '@/lib/http/as-viewer'

/** Upper bound on an uploaded skill, so one file cannot exhaust the store. */
const MAX_SKILL_BYTES = 512 * 1024

export async function GET() {
  return asViewer(async ({ repo }) => NextResponse.json({ skills: await repo.listSkills() }))
}

export async function POST(request: Request) {
  return asViewer(async ({ repo }) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Body must be valid JSON', code: 'INVALID_JSON' },
        { status: 400 },
      )
    }

    const { fileName, content } = (body ?? {}) as { fileName?: unknown; content?: unknown }

    if (typeof fileName !== 'string' || fileName.trim().length === 0) {
      return NextResponse.json(
        { error: 'Field "fileName" must be a non-empty string', code: 'INVALID_BODY' },
        { status: 400 },
      )
    }

    if (typeof content !== 'string' || content.trim().length === 0) {
      return NextResponse.json(
        { error: 'Field "content" must be a non-empty string', code: 'INVALID_BODY' },
        { status: 400 },
      )
    }

    if (!/\.(md|markdown)$/i.test(fileName)) {
      return NextResponse.json(
        { error: 'Only .md files are accepted', code: 'UNSUPPORTED_FILE_TYPE' },
        { status: 400 },
      )
    }

    if (content.length > MAX_SKILL_BYTES) {
      return NextResponse.json(
        { error: `Skill file exceeds ${MAX_SKILL_BYTES / 1024}KB`, code: 'SKILL_TOO_LARGE' },
        { status: 413 },
      )
    }

    // Uploads and the eval both ingest through createSkill, the one path.
    const skill = await repo.createSkill({ fileName, content })
    return NextResponse.json({ skill }, { status: 201 })
  })
}
