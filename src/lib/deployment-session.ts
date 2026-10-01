import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Signed cookie proving a visitor entered a deployment's passcode.
 *
 * HMAC rather than storing the passcode in the cookie: the cookie is
 * attacker-visible, and a signature that only the server can produce means a
 * forged value is rejected without a lookup.
 */

const COOKIE_PREFIX = 'opendots_deploy_'

/**
 * The HMAC key for share-link sessions. An unset OR EMPTY variable (Compose
 * passes "" for one that is unset) falls back to 32 random bytes per process:
 * a restart then invalidates every session, which is a visible failure rather
 * than sessions signed with a known or empty key.
 */
export function sessionSecret(env: Partial<NodeJS.ProcessEnv> = process.env): string {
  return env.DEPLOYMENT_SESSION_SECRET || randomBytes(32).toString('hex')
}

const SESSION_SECRET = sessionSecret()

export function cookieNameFor(deploymentId: string): string {
  return `${COOKIE_PREFIX}${deploymentId}`
}

export function signSession(deploymentId: string, passcode: string): string {
  return createHmac('sha256', SESSION_SECRET)
    .update(`${deploymentId}:${passcode}`)
    .digest('hex')
}

/** Constant-time compare so a wrong value cannot be narrowed by timing. */
export function verifySession(
  token: string | undefined,
  deploymentId: string,
  passcode: string,
): boolean {
  if (!token) return false
  const expected = signSession(deploymentId, passcode)
  const a = Buffer.from(token)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Compares a submitted passcode without leaking its length via early exit. */
export function passcodeMatches(submitted: string, expected: string): boolean {
  const a = Buffer.from(submitted.trim().toUpperCase())
  const b = Buffer.from(expected.toUpperCase())
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
