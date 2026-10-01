import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Pin file tracing to this directory. Without it, Next walks up and finds the
  // sibling monorepo lockfiles under ~/Documents and infers the wrong root.
  outputFileTracingRoot: __dirname,
  // Emits .next/standalone with only the files the server actually needs, so
  // the runtime image does not have to carry node_modules at all.
  output: 'standalone',
  // Loaded from node_modules, not bundled: the SDK resolves its CLI binary, and
  // PGlite its WASM and data files, relative to their own package paths.
  serverExternalPackages: [
    '@anthropic-ai/claude-agent-sdk',
    '@electric-sql/pglite',
    '@electric-sql/pglite-pgvector',
  ],
}

export default nextConfig
