import { NextResponse } from 'next/server'
import { RepositoryError } from '@/lib/repository/chat-repository'
import { getRepository } from '@/lib/repository'

/** Upper bound on an uploaded skill, so one file cannot exhaust the store. */
const MAX_SKILL_BYTES = 512 * 1024

export async function GET() {
  const skills = await getRepository().listSkills()
  return NextResponse.json({ skills })
}

export async function POST(request: Request) {
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

  try {
    // createSkill also vectorises the skill into pgvector when that store is
    // active (see PostgresChatRepository.createSkill), so uploads and the eval
    // both ingest through the one path.
    const skill = await getRepository().createSkill({ fileName, content })
    return NextResponse.json({ skill }, { status: 201 })
  } catch (error) {
    if (error instanceof RepositoryError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    throw error
  }
}
