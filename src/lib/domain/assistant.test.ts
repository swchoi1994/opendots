import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_ASSISTANT, SHELL_BROWSER_WARNING, TOOL_CATALOG, parseAssistantConfig, shellBrowserWarning } from './assistant'

test('parseAssistantConfig fills name and avatar, defaults the model, and drops a legacy provider field', () => {
  const parsed = parseAssistantConfig({ provider: 'claude_code', model: '  ' }, 'Chief of Staff')
  assert.equal('provider' in parsed, false)
  assert.equal(parsed.model, 'default')
  assert.equal(parsed.name, 'Chief of Staff')
  assert.ok(parsed.avatar.shape && parsed.avatar.color)
})

test('the Files tool says it is confined to the workspace', () => {
  const files = TOOL_CATALOG.find((t) => t.id === 'files')
  assert.match(files?.description ?? '', /inside the bot's own workspace/)
  assert.match(files?.description ?? '', /can't change its own configuration/)
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

test('shell plus browser carries a warning; either alone does not', () => {
  assert.equal(shellBrowserWarning(['shell', 'web_browser']), SHELL_BROWSER_WARNING)
  assert.equal(shellBrowserWarning(['web_browser', 'files', 'shell']), SHELL_BROWSER_WARNING)
  assert.equal(shellBrowserWarning(['shell']), null)
  assert.equal(shellBrowserWarning(['web_browser', 'files']), null)
})
