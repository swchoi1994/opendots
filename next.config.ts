import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Pin file tracing to this directory. Without it, Next walks up and finds the
  // sibling monorepo lockfiles under ~/Documents and infers the wrong root.
  outputFileTracingRoot: __dirname,
  // Emits .next/standalone with only the files the server actually needs, so
  // the runtime image does not have to carry node_modules at all.
  output: 'standalone',
  // The SDK spawns the bundled Claude Code CLI and resolves it relative to its
  // own package path, which bundling would break. Load it from node_modules.
  serverExternalPackages: ['@anthropic-ai/claude-agent-sdk'],
}

export default nextConfig
