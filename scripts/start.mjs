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

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i

export function isLoopback(host) {
  return LOOPBACK.test(host)
}

/** Mirrors authMode() in src/lib/auth/viewer.ts; start.test.mjs holds them to the same answers. */
function signInIsOn(env) {
  return Boolean(env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && env.CLERK_SECRET_KEY)
}

/** The `next` arguments for this environment, or why it must not start. */
export function startArgs(env, argv = []) {
  // Every spelling Next accepts: -H x, -Hx, --hostname x, --hostname=x.
  if (argv.some((arg) => arg.startsWith('-H') || arg.startsWith('--hostname'))) {
    return { error: 'Set the address with OPENDOTS_LISTEN_HOST, not -H: the address is checked before OpenDots starts.' }
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
  // Ours goes last: Next takes the last -H it is given, so nothing before it can override the checked address.
  return { args: ['start', ...argv, '-H', host] }
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
