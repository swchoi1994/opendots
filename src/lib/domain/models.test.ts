import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_MODEL_ID, STATIC_MODEL_OPTIONS, modelBadge, resolveModel } from './models'

test('resolveModel routes ollama/ ids to Ollama and everything else to the Anthropic API', () => {
  assert.deepEqual(resolveModel('ollama/qwq:latest'), { provider: 'ollama', sdkModel: 'qwq:latest' })
  assert.deepEqual(resolveModel('  ollama/llama3.1:8b '), { provider: 'ollama', sdkModel: 'llama3.1:8b' })
  assert.deepEqual(resolveModel('sonnet'), { provider: 'anthropic', sdkModel: 'sonnet' })
  assert.deepEqual(resolveModel('claude-sonnet-5'), { provider: 'anthropic', sdkModel: 'claude-sonnet-5' })
})

test('resolveModel refuses ids that are not concrete', () => {
  assert.throws(() => resolveModel(DEFAULT_MODEL_ID), /resolve "default" first/)
  assert.throws(() => resolveModel('ollama/'), /needs a model name/)
})

test('modelBadge names the provider without throwing on odd input', () => {
  assert.equal(modelBadge('default'), 'Default model')
  assert.equal(modelBadge('ollama/qwq:latest'), 'Ollama · qwq:latest')
  assert.equal(modelBadge('ollama/'), 'Ollama · ?')
  assert.equal(modelBadge('sonnet'), 'Claude · sonnet')
  assert.equal(modelBadge('claude-opus-5-5'), 'Claude · claude-opus-5-5')
  assert.equal(modelBadge('openai/gpt-5'), 'API · openai/gpt-5', 'a non-Claude model behind ANTHROPIC_BASE_URL is not labelled Claude')
})

test('the static options start with the default entry', () => {
  assert.equal(STATIC_MODEL_OPTIONS[0]?.id, DEFAULT_MODEL_ID)
  assert.deepEqual(STATIC_MODEL_OPTIONS.slice(1).map((o) => o.id), ['sonnet', 'opus', 'haiku'])
})
