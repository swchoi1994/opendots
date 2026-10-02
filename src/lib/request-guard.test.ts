import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allowedHostsFrom, checkRequest, type RequestFacts } from './request-guard'

const LOCAL = '127.0.0.1:3000'

function post(path: string, headers: Partial<Omit<RequestFacts, 'method' | 'pathname'>> = {}): RequestFacts {
  return { method: 'POST', pathname: path, host: LOCAL, origin: null, secFetchSite: null, ...headers }
}

function get(path: string, headers: Partial<Omit<RequestFacts, 'method' | 'pathname'>> = {}): RequestFacts {
  return { ...post(path, headers), method: 'GET' }
}

const MESSAGES = '/api/channels/bot_chief-of-staff/messages'

test('a same-origin POST from the app is allowed', () => {
  assert.deepEqual(
    checkRequest(post(MESSAGES, { origin: 'http://127.0.0.1:3000', secFetchSite: 'same-origin' }), []),
    { ok: true },
  )
  assert.deepEqual(checkRequest(post(MESSAGES, { host: 'localhost:3000', origin: 'http://localhost:3000' }), []), { ok: true })
  assert.deepEqual(checkRequest(post(MESSAGES, { host: '[::1]:3000', origin: 'http://[::1]:3000' }), []), { ok: true })
})

test('a POST with no Origin (curl, a script on this machine) is allowed', () => {
  assert.deepEqual(checkRequest(post(MESSAGES), []), { ok: true })
})

test('a cross-site POST is blocked', () => {
  const verdict = checkRequest(post(MESSAGES, { origin: 'https://evil.example', secFetchSite: 'cross-site' }), [])
  assert.equal(verdict.ok, false)
  // Either signal is enough on its own.
  assert.equal(checkRequest(post(MESSAGES, { secFetchSite: 'cross-site' }), []).ok, false)
  assert.equal(checkRequest(post(MESSAGES, { origin: 'https://evil.example' }), []).ok, false)
})

test('an Origin that is not exactly this host is blocked, including another local port and "null"', () => {
  assert.equal(checkRequest(post(MESSAGES, { host: 'localhost:3000', origin: 'http://localhost:5173', secFetchSite: 'same-site' }), []).ok, false)
  assert.equal(checkRequest(post(MESSAGES, { origin: 'null' }), []).ok, false)
  assert.equal(checkRequest(post('/api/channels/bot_x/respond', { origin: 'http://localhost:3000' }), []).ok, false, '127.0.0.1 and localhost are different origins')
})

test('a request whose Host is not a loopback name is blocked, GET included (DNS rebinding)', () => {
  for (const host of ['evil.example:3000', 'evil.example', 'localhost.evil.example:3000', '127.0.0.2:3000', '192.168.1.20:3000', '0.0.0.0:3000']) {
    assert.equal(checkRequest(get('/api/channels', { host }), []).ok, false, host)
    assert.equal(checkRequest(get('/', { host }), []).ok, false, host)
  }
  assert.equal(checkRequest(get('/api/channels', { host: null }), []).ok, false, 'no Host at all')
})

test('a host listed in OPENDOTS_ALLOWED_HOSTS is allowed', () => {
  const allowed = allowedHostsFrom({ OPENDOTS_ALLOWED_HOSTS: ' opendots.lan , Box.Local:8080,,' })
  assert.deepEqual(allowed, ['opendots.lan', 'box.local:8080'])
  assert.deepEqual(checkRequest(get('/api/channels', { host: 'opendots.lan:3000' }), allowed), { ok: true })
  assert.deepEqual(checkRequest(post(MESSAGES, { host: 'opendots.lan:3000', origin: 'http://opendots.lan:3000' }), allowed), { ok: true })
  assert.deepEqual(checkRequest(get('/', { host: 'BOX.local:8080' }), allowed), { ok: true })
  assert.equal(checkRequest(get('/', { host: 'box.local:9090' }), allowed).ok, false, 'an entry with a port allows only that port')
  assert.deepEqual(allowedHostsFrom({}), [])
})

test('GETs are not subject to the cross-site rule', () => {
  assert.deepEqual(checkRequest(get('/api/health', { secFetchSite: 'cross-site', origin: 'https://evil.example' }), []), { ok: true })
  assert.deepEqual(checkRequest({ ...get('/api/health'), method: 'HEAD' }, []), { ok: true })
})

test('a request that changes something is refused from another site whatever its path', () => {
  // Next routes /_next/data/<build>/api/….json to the API route itself.
  for (const path of ['/app/0123456789abcdef', '/_next/data/BUILD/api/channels/bot_x/messages.json', '/']) {
    assert.equal(checkRequest(post(path, { origin: 'https://evil.example' }), []).ok, false, path)
  }
  assert.deepEqual(checkRequest(get('/app/0123456789abcdef', { origin: 'https://evil.example' }), []), { ok: true }, 'following a link from another site still works')
})

test('the container healthcheck request passes', () => {
  // node -e "fetch('http://127.0.0.1:3000/api/health')" inside the image.
  assert.deepEqual(checkRequest(get('/api/health', { host: '127.0.0.1:3000' }), []), { ok: true })
})
