import { NextResponse, type NextRequest } from 'next/server'
import { allowedHostsFrom, checkRequest } from './lib/request-guard'

/**
 * Runs before every page and API route (Next 16 calls middleware "proxy").
 * The decision is lib/request-guard.ts: loopback Host names only, and no
 * cross-site API writes. Build assets are skipped: they are the same for
 * everyone and carry no data.
 */
export function proxy(request: NextRequest) {
  const verdict = checkRequest(
    {
      method: request.method,
      pathname: request.nextUrl.pathname,
      host: request.headers.get('host'),
      origin: request.headers.get('origin'),
      secFetchSite: request.headers.get('sec-fetch-site'),
    },
    allowedHostsFrom(process.env),
  )
  if (!verdict.ok) return NextResponse.json({ error: verdict.reason, code: 'FORBIDDEN' }, { status: 403 })
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
}
