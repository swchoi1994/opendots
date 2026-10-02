// Checks a standalone build (OPENDOTS_STANDALONE=1 pnpm build) before it ships.
// The Dockerfile runs it, so a broken image fails to build instead of passing
// its health check while every bot turn fails.
//
//   node scripts/check-standalone.mjs [.next/standalone]
//
// 1. Source, docs and scripts stay out: file tracing that pulls them in means a
//    runtime path is being traced as a build input (see src/lib/data-dir.ts).
// 2. The Agent SDK can find its native CLI for this platform, resolved exactly
//    the way the SDK does it: from its own sdk.mjs, `<platform package>/claude`.
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? '.next/standalone')
const problems = []

for (const dir of ['src', 'docs', 'scripts']) {
  if (existsSync(join(root, dir))) problems.push(`${dir}/ was traced into the standalone output`)
}

const store = join(root, 'node_modules', '.pnpm')
const sdkDir = existsSync(store) ? readdirSync(store).find((name) => name.startsWith('@anthropic-ai+claude-agent-sdk@')) : undefined
if (!sdkDir) {
  problems.push('@anthropic-ai/claude-agent-sdk is missing from the standalone output')
} else {
  const sdk = join(store, sdkDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs')
  const require = createRequire(sdk)
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  const candidates = process.platform === 'linux' ? [`${base}-musl`, base] : [base]
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const found = candidates
    .map((name) => {
      try {
        return require.resolve(`${name}/${exe}`)
      } catch {
        return null
      }
    })
    .find(Boolean)
  if (found) console.log(`native CLI: ${found}`)
  else problems.push(`no native CLI for ${process.platform}-${process.arch} next to the SDK (looked for ${candidates.join(', ')})`)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`standalone check: ${problem}`)
  process.exit(1)
}
console.log('standalone check: ok')
