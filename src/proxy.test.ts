import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NextRequest } from 'next/server'
import { chooseProxy, config, guard } from './proxy'

function request(url: string, init: { method?: string; headers?: Record<string, string> } = {}): NextRequest {
  return new NextRequest(url, { method: init.method ?? 'GET', headers: init.headers })
}

test('local mode runs only the request guard; Clerk mode wraps it in Clerk', () => {
  assert.equal(chooseProxy('local'), guard)
  assert.notEqual(chooseProxy('clerk'), guard)
  assert.equal(typeof chooseProxy('clerk'), 'function')
})

test('the proxy answers 403 to a cross-site POST and lets a same-origin one through', async () => {
  const blocked = guard(request('http://127.0.0.1:3000/api/channels/bot_chief-of-staff/messages', {
    method: 'POST',
    headers: { host: '127.0.0.1:3000', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  }))
  assert.equal(blocked.status, 403)
  assert.match(((await blocked.json()) as { error: string }).error, /another site/)

  const allowed = guard(request('http://127.0.0.1:3000/api/channels/bot_chief-of-staff/messages', {
    method: 'POST',
    headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-origin' },
  }))
  assert.equal(allowed.headers.get('x-middleware-next'), '1', 'NextResponse.next() hands the request on')
})

test("the proxy answers 403 to a cross-site POST through Next's data-route path to the API", () => {
  const blocked = guard(request('http://127.0.0.1:3000/_next/data/BUILD/api/channels/bot_chief-of-staff/messages.json', {
    method: 'POST',
    headers: { host: '127.0.0.1:3000', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  }))
  assert.equal(blocked.status, 403)
})

test('the proxy answers 403 to a foreign Host', () => {
  const blocked = guard(request('http://evil.example:3000/api/channels', { headers: { host: 'evil.example:3000' } }))
  assert.equal(blocked.status, 403)
})

test('the proxy runs on pages and API routes, not on build assets', () => {
  const [matcher] = config.matcher
  const pattern = new RegExp(`^${matcher}$`)
  assert.ok(pattern.test('/api/channels'))
  assert.ok(pattern.test('/'))
  assert.ok(pattern.test('/app/0123456789abcdef'))
  assert.ok(pattern.test('/__clerk/v1/client'), "Clerk's own routes go through clerkMiddleware too")
  assert.ok(!pattern.test('/_next/static/chunks/main.js'))
})
