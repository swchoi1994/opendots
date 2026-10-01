/**
 * Uploaded skills.
 *
 * A skill is a Markdown document with optional YAML-ish frontmatter, following
 * the familiar `skill.md` convention:
 *
 *     ---
 *     name: vet-triage
 *     description: How to triage common pet symptoms
 *     ---
 *
 *     ...body...
 *
 * Uploaded skills are indexed alongside the built-in corpus, so Knowledge
 * Search retrieves from them — that is where a conversation's retrievable
 * knowledge actually comes from.
 */

export interface Skill {
  id: string
  name: string
  description: string
  body: string
  fileName: string
  uploadedAt: number
}

export interface ParsedSkill {
  name: string
  description: string
  body: string
}

/** Strips a `.md`/`.markdown` extension and tidies separators into spaces. */
function nameFromFileName(fileName: string): string {
  const base = fileName.replace(/\.(md|markdown)$/i, '').trim()
  const cleaned = base.replace(/[-_]+/g, ' ').trim()
  return cleaned.length > 0 ? cleaned : 'Untitled skill'
}

/** First non-empty, non-heading line — a reasonable stand-in for a description. */
function descriptionFromBody(body: string): string {
  const line = body
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && !entry.startsWith('#'))
  return line ? line.slice(0, 200) : 'No description provided.'
}

/**
 * Parses frontmatter without a YAML dependency.
 *
 * Only flat `key: value` pairs are supported, which is all the skill format
 * needs. Anything unparseable degrades to a filename-derived name rather than
 * rejecting the upload.
 */
export function parseSkillMarkdown(fileName: string, raw: string): ParsedSkill {
  const normalised = raw.replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalised)

  if (!match) {
    const body = normalised.trim()
    return {
      name: nameFromFileName(fileName),
      description: descriptionFromBody(body),
      body,
    }
  }

  const fields = new Map<string, string>()
  for (const line of (match[1] ?? '').split('\n')) {
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim().toLowerCase()
    // Tolerate quoted values, which frontmatter often carries.
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
    if (key) fields.set(key, value)
  }

  const body = normalised.slice(match[0].length).trim()
  const name = fields.get('name')
  const description = fields.get('description')

  return {
    name: name && name.length > 0 ? name : nameFromFileName(fileName),
    description: description && description.length > 0 ? description : descriptionFromBody(body),
    body,
  }
}

export class InvalidSkillError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidSkillError'
  }
}

/** Guards against empty uploads, which would index as a zero-signal document. */
export function assertUsableSkill(parsed: ParsedSkill): void {
  if (parsed.body.trim().length === 0) {
    throw new InvalidSkillError('Skill file has no content below the frontmatter')
  }
}
