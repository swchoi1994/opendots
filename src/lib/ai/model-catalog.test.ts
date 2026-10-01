import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildModelOptions, listOllamaModels, ollamaHost, resolveDefaultModel, type OllamaModel } from './model-catalog'

const qwq: OllamaModel = { name: 'qwq:latest', tools: true }
const phi: OllamaModel = { name: 'phi3:latest', tools: false }

test('ollamaHost accepts the forms Ollama itself accepts', () => {
  assert.equal(ollamaHost({}), 'http://localhost:11434')
  assert.equal(ollamaHost({ OLLAMA_HOST: '0.0.0.0' }), 'http://127.0.0.1:11434', 'a server bind address is not a client URL')
  assert.equal(ollamaHost({ OLLAMA_HOST: '127.0.0.1:11500' }), 'http://127.0.0.1:11500')
  assert.equal(ollamaHost({ OLLAMA_HOST: 'http://gpu-box:11434/' }), 'http://gpu-box:11434')
  assert.equal(ollamaHost({ OLLAMA_HOST: 'https://ollama.example.com' }), 'https://ollama.example.com')
  assert.equal(ollamaHost({ OLLAMA_HOST: 'http://[bad' }), 'http://[bad', 'garbage is passed through, never thrown')
})

test('listOllamaModels reads names and the tools capability, and returns null when Ollama is down', async () => {
  const ok = (async () =>
    new Response(JSON.stringify({ models: [{ name: 'qwq:latest', capabilities: ['completion', 'tools'] }, { name: 'phi3:latest', capabilities: ['completion'] }, { name: 42 }] }))) as unknown as typeof fetch
  assert.deepEqual(await listOllamaModels('http://x', ok), [qwq, phi])

  const down = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
  assert.equal(await listOllamaModels('http://x', down), null)

  const broken = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
  assert.equal(await listOllamaModels('http://x', broken), null)
})

test('resolveDefaultModel: configured, then API key, then a local tools model, then sonnet', async () => {
  const none = async () => null
  const local = async () => [phi, qwq]
  assert.equal(await resolveDefaultModel({ env: { OPENDOTS_DEFAULT_MODEL: 'opus' }, listModels: local }), 'opus')
  assert.equal(await resolveDefaultModel({ env: { OPENDOTS_DEFAULT_MODEL: 'default', ANTHROPIC_API_KEY: 'k' }, listModels: local }), 'sonnet', '"default" cannot name itself')
  assert.equal(await resolveDefaultModel({ env: { ANTHROPIC_API_KEY: 'k' }, listModels: local }), 'sonnet')
  assert.equal(await resolveDefaultModel({ env: {}, listModels: local }), 'ollama/qwq:latest', 'phi3 has no tools, so it is skipped')
  assert.equal(await resolveDefaultModel({ env: {}, listModels: none }), 'sonnet')
})

test('buildModelOptions marks Claude unavailable without a key and lists only tools-capable local models', async () => {
  const built = await buildModelOptions({ env: {}, listModels: async () => [phi, qwq] })
  assert.equal(built.defaultModel, 'ollama/qwq:latest')
  assert.deepEqual(built.ollama, { host: 'http://localhost:11434', reachable: true })
  assert.deepEqual(built.options.map((o) => [o.id, o.available]), [
    ['default', true], ['sonnet', false], ['opus', false], ['haiku', false], ['ollama/qwq:latest', true],
  ])
  assert.equal(built.options[0]?.label, 'Default (ollama/qwq:latest)')

  const withKey = await buildModelOptions({ env: { ANTHROPIC_API_KEY: 'k' }, listModels: async () => null })
  assert.equal(withKey.ollama.reachable, false)
  assert.ok(withKey.options.filter((o) => o.provider === 'anthropic').every((o) => o.available))
})
