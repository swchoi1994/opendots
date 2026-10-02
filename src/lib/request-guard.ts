/**
 * Who may talk to this server. Without sign-in the boundary is the machine:
 * the server listens on 127.0.0.1, and this check (run by
 * src/proxy.ts on every request) closes the two ways a web page the operator
 * visits could still reach it.
 *
 * - DNS rebinding: a page on evil.example re-points its own name at 127.0.0.1
 *   and then reads and writes the API as "same origin". Its requests still
 *   carry `Host: evil.example`, so any Host that is not a loopback name (or
 *   listed in OPENDOTS_ALLOWED_HOSTS) is refused.
 * - Cross-site requests: a form or fetch from another site can POST without
 *   reading the answer, enough to send a bot a message and make it act. Every
 *   request that changes something must come from this origin, whatever its
 *   path: Next also routes `/_next/data/<build>/api/….json` to the API, so a
 *   rule keyed on `/api` alone has a side door.
 *
 * Pure, so it is tested without a server.
 */

export interface RequestFacts {
  method: string
  pathname: string
  /** The Host header as received. */
  host: string | null
  origin: string | null
  secFetchSite: string | null
}

export type RequestVerdict = { ok: true } | { ok: false; reason: string }

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])
const SAFE_METHODS = new Set(['GET', 'HEAD'])

export const FOREIGN_HOST =
  'This OpenDots server only answers on 127.0.0.1, localhost or [::1]. To reach it by another name, list that name in OPENDOTS_ALLOWED_HOSTS.'
export const CROSS_SITE = 'OpenDots refuses requests that change something when they come from another site.'

/** OPENDOTS_ALLOWED_HOSTS: comma-separated names, each optionally with a port. */
export function allowedHostsFrom(env: Partial<NodeJS.ProcessEnv>): string[] {
  return (env.OPENDOTS_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}

/** `host[:port]` split the way URL does it (brackets kept on IPv6), or null when it does not parse. */
function parseHost(value: string, scheme = 'http:'): { host: string; hostname: string } | null {
  try {
    const url = new URL(`${scheme}//${value}`)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return { host: url.host, hostname: url.hostname }
  } catch {
    return null
  }
}

function hostAllowed(host: string | null, allowedHosts: string[]): boolean {
  if (!host) return false
  const parsed = parseHost(host.toLowerCase())
  if (!parsed) return false
  if (LOOPBACK_NAMES.has(parsed.hostname)) return true
  return allowedHosts.some((entry) => entry === parsed.host || entry === parsed.hostname)
}

/** Whether `origin` (scheme://host[:port]) names exactly the host this request was sent to. */
function sameOrigin(origin: string, host: string): boolean {
  try {
    const url = new URL(origin)
    const target = parseHost(host.toLowerCase(), url.protocol)
    return target !== null && url.origin !== 'null' && url.host === target.host
  } catch {
    return false // "null", or anything else that is not an origin
  }
}

export function checkRequest(request: RequestFacts, allowedHosts: string[]): RequestVerdict {
  if (!hostAllowed(request.host, allowedHosts)) return { ok: false, reason: FOREIGN_HOST }

  const changesSomething = !SAFE_METHODS.has(request.method.toUpperCase())
  if (changesSomething) {
    if (request.secFetchSite?.toLowerCase() === 'cross-site') return { ok: false, reason: CROSS_SITE }
    if (request.origin !== null && !sameOrigin(request.origin, request.host!)) return { ok: false, reason: CROSS_SITE }
  }
  return { ok: true }
}
