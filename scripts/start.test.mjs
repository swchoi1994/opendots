import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authMode } from '../src/lib/auth/viewer.ts'
import { isLoopback, startArgs } from './start.mjs'

const KEYS = { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_x', CLERK_SECRET_KEY: 'sk_test_x' }

test('by default OpenDots listens on 127.0.0.1, and extra arguments pass through', () => {
  assert.deepEqual(startArgs({}), { args: ['start', '-H', '127.0.0.1'] })
  assert.deepEqual(startArgs({ OPENDOTS_LISTEN_HOST: '  ' }, ['-p', '3130']), { args: ['start', '-p', '3130', '-H', '127.0.0.1'] })
})

test('without sign-in, only loopback addresses are allowed', () => {
  for (const host of ['127.0.0.1', '127.0.0.53', 'localhost', '::1', '[::1]']) {
    assert.ok(isLoopback(host), host)
    assert.deepEqual(startArgs({ OPENDOTS_LISTEN_HOST: host }), { args: ['start', '-H', host] })
  }
  for (const host of ['0.0.0.0', '::', '192.168.1.20', 'opendots.example.com', '127.0.0.1.example.com']) {
    assert.match(startArgs({ OPENDOTS_LISTEN_HOST: host }).error ?? '', /without sign-in/, host)
  }
})

test('with sign-in on, any address is allowed', () => {
  assert.deepEqual(startArgs({ ...KEYS, OPENDOTS_LISTEN_HOST: '0.0.0.0' }), { args: ['start', '-H', '0.0.0.0'] })
})

test('-H on the command line is refused, so it cannot step around the check', () => {
  for (const argv of [['-H', '0.0.0.0'], ['-H0.0.0.0'], ['-H=0.0.0.0'], ['--hostname', '0.0.0.0'], ['--hostname=0.0.0.0'], ['-p', '3130', '-H0.0.0.0']]) {
    assert.match(startArgs({}, argv).error ?? '', /OPENDOTS_LISTEN_HOST/)
  }
})

test("the start script's idea of sign-in is the app's", () => {
  const envs = [{}, KEYS, { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk' }, { CLERK_SECRET_KEY: 'sk' }, { ...KEYS, CLERK_SECRET_KEY: '' }]
  for (const env of envs) {
    const allowedPublic = !startArgs({ ...env, OPENDOTS_LISTEN_HOST: '0.0.0.0' }).error
    assert.equal(allowedPublic, authMode(env) === 'clerk', JSON.stringify(env))
  }
})
