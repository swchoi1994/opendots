import { clerkMiddleware } from '@clerk/nextjs/server'
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server'
import { authMode } from './lib/auth/viewer'
import { allowedHostsFrom, checkRequest } from './lib/request-guard'

/**
 * Runs before every page and API route (Next 16 calls middleware "proxy").
 * The decision is lib/request-guard.ts: loopback Host names only, and no
 * cross-site API writes. Build assets are skipped: they are the same for
 * everyone and carry no data.
 */
export function guard(request: NextRequest): NextResponse {
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

/*
 * With sign-in on, the guard runs inside Clerk's middleware, which only makes
 * auth() available: every route and page decides for itself who may call it,
 * as Clerk recommends. Clerk's middleware needs the keys, so local mode runs
 * the guard alone. Building it reads no keys; they are read per request.
 */
const guardWithClerk = clerkMiddleware((_auth, request) => guard(request), {
  // OpenDots's own pages, so redirectToSignIn() never sends anyone to Clerk's hosted portal.
  signInUrl: '/sign-in',
  signUpUrl: '/sign-up',
})

export function chooseProxy(mode: 'clerk' | 'local') {
  return mode === 'clerk' ? guardWithClerk : guard
}

export function proxy(request: NextRequest, event: NextFetchEvent) {
  return chooseProxy(authMode())(request, event)
}

export const config = {
  // Everything but build assets, which includes Clerk's own `/__clerk/*` routes.
  matcher: ['/((?!_next/static|_next/image).*)'],
}
