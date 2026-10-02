import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NextConfig } from 'next'

const standalone = process.env.OPENDOTS_STANDALONE === '1'

/** The installed Agent SDK version, so the trace below picks exactly its platform package. */
function sdkVersion(): string {
  const manifest = join(__dirname, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json')
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version
}

const nextConfig: NextConfig = {
  // Give the proxy the request's own URL. Otherwise Next rebuilds it as
  // http://localhost:<port> even when serving on 127.0.0.1, and Clerk's
  // middleware, which re-points each request at that URL, makes Next treat it
  // as another site and proxy the request to itself in a loop (every Clerk-mode
  // request a 500). Normalising only matters for Pages Router data routes.
  skipProxyUrlNormalize: true,
  // Pin file tracing to this directory. Without it, Next walks up and finds the
  // sibling monorepo lockfiles under ~/Documents and infers the wrong root.
  outputFileTracingRoot: __dirname,
  // Emits .next/standalone with only the files the server actually needs, so
  // the runtime image does not have to carry node_modules at all. Docker-only
  // (the Dockerfile sets OPENDOTS_STANDALONE=1): `next start` warns on a
  // standalone build, and `pnpm start` should serve a normal one.
  output: standalone ? 'standalone' : undefined,
  // The SDK finds its native CLI with a computed require.resolve of
  // `@anthropic-ai/claude-agent-sdk-<platform>/claude`, which tracing cannot
  // follow, so standalone output would ship without it ("Native CLI binary …
  // not found" on every turn). Pull in whichever platform package pnpm
  // installed — in the Docker build, linux musl for the build machine's arch.
  ...(standalone
    ? {
        outputFileTracingIncludes: {
          '/api/**': [
            `./node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@${sdkVersion()}_*/node_modules/@anthropic-ai/claude-agent-sdk-*/{claude,claude.exe,package.json}`,
          ],
        },
        // Runtime paths (bot workspaces, symlink targets, skills folders) are
        // computed from variables, and tracing reads them as "this module's
        // folder". The compiled server never reads source, docs or scripts, so
        // keep them out of the image regardless of what tracing guesses.
        outputFileTracingExcludes: {
          '/**': ['./src/**/*', './docs/**/*', './scripts/**/*'],
        },
      }
    : {}),
  // Loaded from node_modules, not bundled: the SDK resolves its CLI binary, and
  // PGlite its WASM and data files, relative to their own package paths.
  serverExternalPackages: [
    '@anthropic-ai/claude-agent-sdk',
    '@electric-sql/pglite',
    '@electric-sql/pglite-pgvector',
  ],
}

export default nextConfig
