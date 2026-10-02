import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { baseEnv } from '../brain-env'

/**
 * skills.sh client.
 *
 * Bots extend themselves by installing skills (SKILL.md packages) from
 * https://skills.sh into their own workspace's `.claude/skills/`, which the
 * Agent SDK loads on the next turn via `settingSources: ['project']`.
 * Search prefers the JSON API; the `skills` CLI is the fallback because its
 * output is meant for humans and needs parsing.
 */

export interface SkillSearchResult {
  /** `owner/repo@skill` — exactly what `npx skills add` accepts. */
  ref: string
  name: string
  source: string
  installs: number
  url: string
}

export type CommandRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ code: number; stdout: string; stderr: string }>

const SKILL_REF = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/
const SEARCH_URL = 'https://skills.sh/api/search'
const SEARCH_TIMEOUT_MS = 15_000
const INSTALL_TIMEOUT_MS = 120_000

export function validateSkillRef(ref: string): string {
  const trimmed = ref.trim()
  // The ref becomes a CLI argument; the allowlist keeps shell metacharacters
  // and path traversal out by construction rather than by escaping.
  if (!SKILL_REF.test(trimmed) || trimmed.includes('..')) {
    throw new Error(`Invalid skill ref "${ref}". Expected owner/repo@skill.`)
  }
  return trimmed
}

const defaultRunner: CommandRunner = (cmd, args, { cwd, timeoutMs }) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      // The cast is Next's doing: its `global.d.ts` makes `NODE_ENV` a required
      // literal union, which baseEnv's plain Record<string, string> cannot satisfy.
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...baseEnv(process.env), CI: '1' } as unknown as NodeJS.ProcessEnv },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code)
            : error
              ? 1
              : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) + (error ? `\n${error.message}` : '') })
      },
    )
  })

interface ApiSkill {
  id?: unknown
  skillId?: unknown
  name?: unknown
  installs?: unknown
  source?: unknown
}

export function parseSearchResponse(json: unknown): SkillSearchResult[] {
  const skills = (json as { skills?: unknown })?.skills
  if (!Array.isArray(skills)) return []
  const results: SkillSearchResult[] = []
  for (const entry of skills as ApiSkill[]) {
    if (typeof entry.source !== 'string' || typeof entry.skillId !== 'string') continue
    const ref = `${entry.source}@${entry.skillId}`
    if (!SKILL_REF.test(ref)) continue
    results.push({
      ref,
      name: typeof entry.name === 'string' ? entry.name : entry.skillId,
      source: entry.source,
      installs: typeof entry.installs === 'number' ? entry.installs : 0,
      url: `https://skills.sh/${typeof entry.id === 'string' ? entry.id : `${entry.source}/${entry.skillId}`}`,
    })
  }
  return results.sort((a, b) => b.installs - a.installs)
}

const ANSI = /\x1b\[[0-9;]*m/g

function parseInstalls(raw: string): number {
  const match = /([0-9.]+)\s*([KkMm])?/.exec(raw)
  if (!match) return 0
  const base = Number.parseFloat(match[1]!)
  const unit = match[2]?.toUpperCase()
  return Math.round(base * (unit === 'K' ? 1_000 : unit === 'M' ? 1_000_000 : 1))
}

export function parseSkillsFindOutput(text: string): SkillSearchResult[] {
  const results: SkillSearchResult[] = []
  for (const rawLine of text.replace(ANSI, '').split('\n')) {
    const line = rawLine.trim()
    const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+)\s+(.*)$/.exec(line)
    if (!match) continue
    const ref = match[1]!
    const [source, skill] = ref.split('@') as [string, string]
    results.push({
      ref,
      name: skill,
      source,
      installs: parseInstalls(match[2] ?? ''),
      url: `https://skills.sh/${source}/${skill}`,
    })
  }
  return results
}

export async function searchSkills(
  query: string,
  opts: { fetchImpl?: typeof fetch; runner?: CommandRunner; limit?: number } = {},
): Promise<SkillSearchResult[]> {
  const limit = opts.limit ?? 8
  const fetchImpl = opts.fetchImpl ?? fetch
  const trimmed = query.trim()
  if (!trimmed) return []

  try {
    const response = await fetchImpl(`${SEARCH_URL}?q=${encodeURIComponent(trimmed)}`, {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    })
    if (response.ok) {
      const parsed = parseSearchResponse(await response.json())
      if (parsed.length > 0) return parsed.slice(0, limit)
    }
  } catch {
    // Fall through to the CLI.
  }

  const runner = opts.runner ?? defaultRunner
  const { stdout } = await runner('npx', ['-y', 'skills@latest', 'find', trimmed], {
    cwd: process.cwd(),
    timeoutMs: 60_000,
  })
  return parseSkillsFindOutput(stdout).slice(0, limit)
}

/**
 * The SKILL.md this run actually produced.
 *
 * Comparing against a snapshot taken before the CLI ran is what makes the
 * check honest: picking "the newest folder with a SKILL.md" reported success
 * for a run that wrote nothing at all (the CLI exits 0 when the skill is
 * already installed) by handing back a skill some earlier turn had installed.
 */
function findInstalledSkillMd(skillsDir: string, skill: string, before: Map<string, number>): string | null {
  if (!existsSync(skillsDir)) return null
  const fresh = readdirSync(skillsDir)
    .map((name) => ({ name, md: join(skillsDir, name, 'SKILL.md') }))
    .filter(({ md }) => existsSync(md))
    .filter(({ name, md }) => {
      const previous = before.get(name)
      return previous === undefined || statSync(md).mtimeMs > previous
    })
  // The CLI may normalise the folder name, so fall back to the newest new one.
  const exact = fresh.find(({ name }) => name === skill)
  if (exact) return exact.md
  const newest = fresh.sort((a, b) => statSync(b.md).mtimeMs - statSync(a.md).mtimeMs)[0]
  return newest ? newest.md : null
}

export async function installSkill(
  ref: string,
  workspaceDir: string,
  opts: { runner?: CommandRunner } = {},
): Promise<{ skill: string; path: string }> {
  const valid = validateSkillRef(ref)
  const skill = valid.slice(valid.indexOf('@') + 1)
  const runner = opts.runner ?? defaultRunner

  // npx runs in a staging directory OpenDots creates, never in the workspace:
  // npm reads a project .npmrc by walking up from its cwd, so a bot that wrote
  // <workspace>/.npmrc (registry=…) could otherwise choose the code npx runs.
  const staging = mkdtempSync(join(tmpdir(), 'opendots-skill-'))
  try {
    const stagedSkills = join(staging, '.claude', 'skills')
    const { code, stderr, stdout } = await runner(
      'npx',
      ['-y', 'skills@latest', 'add', valid, '-y', '-a', 'claude-code', '--copy'],
      { cwd: staging, timeoutMs: INSTALL_TIMEOUT_MS },
    )
    if (code !== 0) {
      throw new Error(`skills add failed (${code}): ${(stderr || stdout).trim().slice(-800)}`)
    }

    const staged = findInstalledSkillMd(stagedSkills, skill, new Map())
    if (!staged) {
      throw new Error(
        `skills add exited 0 but wrote no new skill under .claude/skills — is "${valid}" already installed?`,
      )
    }

    // Copy (not rename): the temp dir and the workspace can be on different volumes.
    const folder = basename(dirname(staged))
    const target = join(workspaceDir, '.claude', 'skills', folder)
    mkdirSync(dirname(target), { recursive: true })
    rmSync(target, { recursive: true, force: true })
    cpSync(dirname(staged), target, { recursive: true })
    return { skill, path: join(target, 'SKILL.md') }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
