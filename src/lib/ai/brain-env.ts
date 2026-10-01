import { join } from 'node:path'
import type { ResolvedModel } from '../domain/models'
import { ollamaHost } from './model-catalog'

/** Kept because a CLI subprocess without them cannot find node, npx, or a home. */
const BASE_ALLOWLIST = ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'SHELL'] as const

/**
 * The base subprocess environment: an allowlist of the handful of variables a
 * spawned CLI needs to find node, npx or a home, plus NO_COLOR. This is the
 * one place that list is spelled out — `brainEnv` below builds on it, and the
 * other two subprocess callers (agent-browser.ts, tools/skills-sh.ts) import
 * it directly rather than keeping their own copy, so the allowlist can only
 * drift by being changed here.
 */
export function baseEnv(source: Partial<NodeJS.ProcessEnv>): Record<string, string> {
  const env: Record<string, string> = { NO_COLOR: '1' }
  for (const key of BASE_ALLOWLIST) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) env[key] = value
  }
  return env
}

/**
 * The environment the Agent SDK's CLI subprocess runs with, built from an
 * allowlist. The SDK replaces the subprocess environment outright when `env`
 * is given, so anything not added here (DATABASE_URL, the share-link secret,
 * Clerk keys) never reaches a bot — including a bot that has `shell`.
 *
 * CLAUDE_CONFIG_DIR is always OpenDots' own directory: bots never read the
 * operator's ~/.claude (settings, memory, login) and their sessions never
 * land there. There is deliberately no path to a claude.ai subscription login.
 */
export function brainEnv(
  resolved: ResolvedModel,
  source: Partial<NodeJS.ProcessEnv>,
  dataDir: string,
): Record<string, string> {
  const env: Record<string, string> = { ...baseEnv(source), CLAUDE_CONFIG_DIR: join(dataDir, 'claude') }

  if (resolved.provider === 'anthropic') {
    if (source.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = source.ANTHROPIC_API_KEY
    // OpenRouter, a LiteLLM proxy, or any other Anthropic-compatible endpoint.
    if (source.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = source.ANTHROPIC_BASE_URL
    return env
  }

  // Ollama speaks the Anthropic Messages API, so the same CLI runs against it.
  env.ANTHROPIC_BASE_URL = ollamaHost(source)
  env.ANTHROPIC_AUTH_TOKEN = 'ollama'
  // The CLI makes background calls on its "small" model; keep those local too.
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = resolved.sdkModel
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = resolved.sdkModel
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = resolved.sdkModel
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  return env
}
