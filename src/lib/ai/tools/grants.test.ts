import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toolGrants } from './grants'

test('toolGrants maps ToolNames to SDK tool names without duplicates', () => {
  const grants = toolGrants(['rag_search', 'channel_history', 'files', 'skills', 'files'])
  assert.deepEqual(grants.builtins, ['Read', 'Write', 'Edit', 'Glob', 'Grep'])
  assert.deepEqual(grants.mcp, ['mcp__opendots__search_knowledge', 'mcp__opendots__find_skill', 'mcp__opendots__install_skill'])
  assert.deepEqual(grants.all, [...grants.builtins, ...grants.mcp])
})

test('shell grants Bash and web_browser grants the eight browser tools', () => {
  assert.deepEqual(toolGrants(['shell']).builtins, ['Bash'])
  assert.deepEqual(toolGrants(['web_browser']).all, [
    'mcp__opendots__browser_open', 'mcp__opendots__browser_snapshot', 'mcp__opendots__browser_click', 'mcp__opendots__browser_type',
    'mcp__opendots__browser_fill', 'mcp__opendots__browser_press', 'mcp__opendots__browser_scroll', 'mcp__opendots__browser_back',
  ])
  assert.deepEqual(toolGrants([]).all, [])
})

test('web_browser grants the eight browser tools in order', () => {
  assert.deepEqual(toolGrants(['web_browser']).mcp, [
    'mcp__opendots__browser_open', 'mcp__opendots__browser_snapshot', 'mcp__opendots__browser_click', 'mcp__opendots__browser_type',
    'mcp__opendots__browser_fill', 'mcp__opendots__browser_press', 'mcp__opendots__browser_scroll', 'mcp__opendots__browser_back',
  ])
})
