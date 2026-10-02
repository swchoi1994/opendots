/**
 * `pnpm start`: serves the production build on OPENDOTS_LISTEN_HOST (default
 * 127.0.0.1). Any other address is refused unless sign-in is on: without it,
 * whoever reaches the port is the owner, with every bot's Terminal and Files.
 */
import { spawn } from 'node:child_process'
import os from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The loopback names the request guard answers to (src/lib/request-guard.ts),
 * so a server started here never refuses its own address. `::1` is how -H
 * spells what the Host header writes as `[::1]`.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function isLoopback(host) {
  return LOOPBACK.has(host.toLowerCase())
}

/** Mirrors authMode() in src/lib/auth/viewer.ts; start.test.mjs holds them to the same answers. */
function signInIsOn(env) {
  return Boolean(env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && env.CLERK_SECRET_KEY)
}

/** `next start` options that cannot change where it listens or what it exposes; each takes one number. */
const PASSTHROUGH = new Set(['-p', '--port', '--keepAliveTimeout'])

/**
 * Only the options above, so nothing on the command line can move the address
 * (-H in any spelling, a `--` that makes Next drop the rest, --inspect opening
 * the debugger to the network).
 */
function passthroughArgs(argv) {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const [flag, inline] = arg.startsWith('--') ? arg.split(/=(.*)/s) : [arg.slice(0, 2), arg.slice(2) || undefined]
    if (!PASSTHROUGH.has(flag)) return null
    const value = inline ?? argv[++i]
    if (!value || !/^\d+$/.test(value)) return null
    out.push(flag, value)
  }
  return out
}

/** The `next` arguments for this environment, or why it must not start. */
export function startArgs(env, argv = []) {
  const extra = passthroughArgs(argv)
  if (!extra) {
    return {
      error: 'pnpm start takes only --port and --keepAliveTimeout. Set the address with OPENDOTS_LISTEN_HOST: it is checked before OpenDots starts.',
    }
  }
  const host = (env.OPENDOTS_LISTEN_HOST ?? '').trim() || '127.0.0.1'
  if (!isLoopback(host) && !signInIsOn(env)) {
    return {
      error:
        `OpenDots will not listen on ${host} without sign-in: anyone who could reach it would act as you. ` +
        'Set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY (README, "Sign-in and workspaces"), ' +
        'or leave OPENDOTS_LISTEN_HOST at 127.0.0.1.',
    }
  }
  return { args: ['start', '-H', host, ...extra] }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const require = createRequire(join(root, 'package.json'))
  // The same .env files `next start` loads, so the mode decided here is the one Next runs in.
  const nextRequire = createRequire(require.resolve('next/package.json'))
  nextRequire('@next/env').loadEnvConfig(root)

  const plan = startArgs(process.env, process.argv.slice(2))
  if (plan.error) {
    console.error(plan.error)
    process.exit(1)
  }
  const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), ...plan.args], { stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  // A child stopped by a signal exits as shells report it: 128 + the signal's number.
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 0)))
}
