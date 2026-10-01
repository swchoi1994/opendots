import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_ASSISTANT, TOOL_CATALOG, parseAssistantConfig } from './assistant'

test('parseAssistantConfig fills name and avatar and pins the provider', () => {
  const parsed = parseAssistantConfig({ provider: 'azure_openai', model: '  ' }, 'Chief of Staff')
  assert.equal(parsed.provider, 'claude_code')
  assert.equal(parsed.model, DEFAULT_ASSISTANT.model)
  assert.equal(parsed.name, 'Chief of Staff')
  assert.ok(parsed.avatar.shape && parsed.avatar.color)
})

test('parseAssistantConfig drops tools that are not grantable', () => {
  const parsed = parseAssistantConfig({ tools: ['rag_search', 'nope'] })
  assert.deepEqual(parsed.tools, ['rag_search'])
})

test('default tools include the browser, which is grantable', () => {
  assert.deepEqual(DEFAULT_ASSISTANT.tools, ['rag_search', 'channel_history', 'files', 'skills', 'web_browser'])
  assert.equal(TOOL_CATALOG.find((t) => t.id === 'web_browser')?.available, true)
})

test('parseAssistantConfig parses browser.headed, defaulting to false', () => {
  assert.equal(parseAssistantConfig({ browser: { headed: true } }).browser.headed, true)
  assert.equal(parseAssistantConfig({}).browser.headed, false)
  assert.equal(parseAssistantConfig({ browser: { headed: 'yes' } }).browser.headed, false)
})
