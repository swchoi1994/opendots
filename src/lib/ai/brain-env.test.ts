import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { baseEnv, brainEnv } from './brain-env'

const HOST_ENV = {
  PATH: '/usr/bin',
  HOME: '/home/op',
  NODE_ENV: 'test' as const,
  DATABASE_URL: 'postgres://user:pw@host/db',
  DEPLOYMENT_SESSION_SECRET: 'hmac-key',
  CLERK_SECRET_KEY: 'sk_test_x',
  CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token',
  ANTHROPIC_API_KEY: 'sk-ant-operator',
}

test('baseEnv keeps the base allowlist and NO_COLOR, and drops everything else', () => {
  const env = baseEnv({
    ...HOST_ENV,
    USER: 'bot',
    TMPDIR: '/tmp',
    LANG: 'en_US.UTF-8',
    SHELL: '/bin/zsh',
  })
  for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'SHELL']) {
    assert.ok(env[key], `${key} must survive baseEnv`)
  }
  assert.equal(env.NO_COLOR, '1')
  for (const secret of ['DATABASE_URL', 'DEPLOYMENT_SESSION_SECRET', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
    assert.equal(env[secret], undefined, `${secret} must not reach a plain subprocess`)
  }
})

test('an Anthropic run gets the API key and nothing it should not', () => {
  const env = brainEnv({ provider: 'anthropic', sdkModel: 'sonnet' }, HOST_ENV, '/data')
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-operator')
  assert.equal(env.ANTHROPIC_BASE_URL, undefined, 'no base URL unless the operator set one')
  assert.equal(env.CLAUDE_CONFIG_DIR, join('/data', 'claude'))
  assert.equal(env.NO_COLOR, '1')
  for (const secret of ['CLAUDE_CODE_OAUTH_TOKEN', 'DATABASE_URL', 'DEPLOYMENT_SESSION_SECRET', 'CLERK_SECRET_KEY', 'NODE_ENV']) {
    assert.equal(env[secret], undefined, `${secret} must not reach the CLI`)
  }
  const compat = brainEnv({ provider: 'anthropic', sdkModel: 'x' }, { ...HOST_ENV, ANTHROPIC_BASE_URL: 'https://proxy.example' }, '/data')
  assert.equal(compat.ANTHROPIC_BASE_URL, 'https://proxy.example')
})

test('an Ollama run points the CLI at Ollama and never carries the operator key', () => {
  const env = brainEnv({ provider: 'ollama', sdkModel: 'qwq:latest' }, { ...HOST_ENV, OLLAMA_HOST: '0.0.0.0' }, '/data')
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11434')
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'ollama')
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'qwq:latest')
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'qwq:latest')
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'qwq:latest')
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1')
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
  assert.equal(env.PATH, '/usr/bin')
})
