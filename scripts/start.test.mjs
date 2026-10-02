import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authMode } from '../src/lib/auth/viewer.ts'
import { checkRequest } from '../src/lib/request-guard.ts'
import { isLoopback, startArgs } from './start.mjs'

const KEYS = { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_x', CLERK_SECRET_KEY: 'sk_test_x' }

test('by default OpenDots listens on 127.0.0.1, and extra arguments pass through', () => {
  assert.deepEqual(startArgs({}), { args: ['start', '-H', '127.0.0.1'] })
  assert.deepEqual(startArgs({ OPENDOTS_LISTEN_HOST: '  ' }, ['-p', '3130']), { args: ['start', '-H', '127.0.0.1', '-p', '3130'] })
  assert.deepEqual(startArgs({}, ['-p3130', '--port=3131', '--keepAliveTimeout', '5000']), {
    args: ['start', '-H', '127.0.0.1', '-p', '3130', '--port', '3131', '--keepAliveTimeout', '5000'],
  })
})

test('without sign-in, only loopback addresses are allowed', () => {
  for (const host of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
    assert.ok(isLoopback(host), host)
    assert.deepEqual(startArgs({ OPENDOTS_LISTEN_HOST: host }), { args: ['start', '-H', host] })
    // A server started on it must answer to it.
    const hostHeader = host === '::1' ? '[::1]:3000' : `${host}:3000`
    assert.equal(checkRequest({ method: 'GET', pathname: '/', host: hostHeader, origin: null, secFetchSite: null }, []).ok, true, host)
  }
  for (const host of ['0.0.0.0', '::', '127.0.0.53', '192.168.1.20', 'opendots.example.com', '127.0.0.1.example.com']) {
    assert.match(startArgs({ OPENDOTS_LISTEN_HOST: host }).error ?? '', /without sign-in/, host)
  }
})

test('with sign-in on, any address is allowed', () => {
  assert.deepEqual(startArgs({ ...KEYS, OPENDOTS_LISTEN_HOST: '0.0.0.0' }), { args: ['start', '-H', '0.0.0.0'] })
})

test('anything but a port or keep-alive on the command line is refused, so nothing can step around the check', () => {
  const attempts = [
    ['-H', '0.0.0.0'], ['-H0.0.0.0'], ['-H=0.0.0.0'], ['--hostname', '0.0.0.0'], ['--hostname=0.0.0.0'], ['-p', '3130', '-H0.0.0.0'],
    // `--` makes Next take the rest as a directory and drop the -H that follows (Next then listens on 0.0.0.0).
    ['--', '.'], ['.'],
    // The Node inspector on the network is remote code execution.
    ['--inspect', '0.0.0.0:9229'], ['--inspect=0.0.0.0:9229'],
    ['-p'], ['-p', 'abc'], ['--port='],
  ]
  for (const argv of attempts) {
    assert.match(startArgs({}, argv).error ?? '', /OPENDOTS_LISTEN_HOST/, JSON.stringify(argv))
  }
})

test("the start script's idea of sign-in is the app's", () => {
  const envs = [{}, KEYS, { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk' }, { CLERK_SECRET_KEY: 'sk' }, { ...KEYS, CLERK_SECRET_KEY: '' }]
  for (const env of envs) {
    const allowedPublic = !startArgs({ ...env, OPENDOTS_LISTEN_HOST: '0.0.0.0' }).error
    assert.equal(allowedPublic, authMode(env) === 'clerk', JSON.stringify(env))
  }
})
