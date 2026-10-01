import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { BrowserClient } from '../../browser/agent-browser'
import { browserTools, isFlaggedTarget, type ScreenCapture } from './browser-tools'

function fakeClient(overrides: Partial<BrowserClient> = {}): BrowserClient & { log: string[] } {
  const log: string[] = []
  return {
    log,
    open: async (url, opts) => { log.push(opts?.headed ? `open ${url} headed` : `open ${url}`) },
    snapshot: async () => '- button "Pay now" [ref=e7]\n- link "Docs" [ref=e2]',
    click: async (ref) => { log.push(`click ${ref}`) },
    type: async (ref, text) => { log.push(`type ${ref} ${text}`) },
    fill: async (ref, text) => { log.push(`fill ${ref} ${text}`) },
    press: async (key) => { log.push(`press ${key}`) },
    scroll: async (d, px) => { log.push(`scroll ${d} ${px ?? ''}`) },
    back: async () => { log.push('back') },
    getUrl: async () => 'https://shop.example/checkout',
    getTitle: async () => 'Checkout',
    screenshotAnnotated: async (path) => ({ path, annotations: [{ number: 1, ref: 'e7', role: 'button', name: 'Pay now', box: { x: 0, y: 0, width: 1, height: 1 } }] }),
    close: async () => {},
    ...overrides,
  }
}

async function call(tools: ReturnType<typeof browserTools>, name: string, args: Record<string, unknown>) {
  const tool = tools.find((t) => t.name === name)!
  return (await tool.handler(args as never, {} as never)) as { content: { type: string; text: string }[]; isError?: boolean }
}

test('isFlaggedTarget marks irreversible-looking controls', () => {
  assert.equal(isFlaggedTarget('Pay now'), true)
  assert.equal(isFlaggedTarget('Place order'), true)
  assert.equal(isFlaggedTarget('Delete account'), true)
  assert.equal(isFlaggedTarget('Learn more'), false)
  assert.equal(isFlaggedTarget(null), false)
})

test('every acting tool captures exactly one screen; snapshot captures none', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-screens-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const captures: ScreenCapture[] = []
  const client = fakeClient()
  const tools = browserTools({ client, screensDir: dir, onScreen: async (c) => { captures.push(c) } })
  assert.equal(tools.length, 8)

  const opened = await call(tools, 'browser_open', { url: 'https://shop.example/checkout', intent: 'open checkout' })
  assert.ok(opened.content[0]!.text.includes('Checkout'))
  assert.ok(opened.content[0]!.text.includes('[ref=e7]'))
  await call(tools, 'browser_snapshot', { interactive: true })
  await call(tools, 'browser_click', { ref: 'e7', intent: 'pay for the order' })
  await call(tools, 'browser_type', { ref: 'e2', text: 'hi', intent: 'type' })
  await call(tools, 'browser_fill', { ref: 'e2', text: 'replaced', intent: 'fill the box' })
  await call(tools, 'browser_press', { key: 'Enter', intent: 'submit' })
  await call(tools, 'browser_scroll', { direction: 'down', px: 400, intent: 'scroll' })
  await call(tools, 'browser_back', { intent: 'go back' })

  assert.equal(captures.length, 7)
  assert.deepEqual(captures.map((c) => c.step), [1, 2, 3, 4, 5, 6, 7])
  assert.equal(captures[0]!.action, 'open')
  assert.equal(captures[1]!.action, 'click')
  assert.equal(captures[1]!.target, '@e7')
  assert.equal(captures[1]!.intent, 'pay for the order')
  assert.equal(captures[1]!.flagged, true, 'clicking "Pay now" is flagged from the snapshot name')
  assert.equal(captures[2]!.flagged, false)
  assert.equal(captures[3]!.action, 'fill')
  assert.equal(captures[3]!.target, '@e2')
  assert.equal(captures[3]!.intent, 'fill the box')
  assert.equal(captures[3]!.flagged, false, '"Docs" is not an irreversible-looking name')
  assert.ok(captures[0]!.imagePath!.startsWith(dir))
  assert.ok(captures[0]!.imagePath!.endsWith('/1.jpg'))
  // The stored path is the one we asked for, never the CLI's echo.
  assert.equal(captures[3]!.imagePath, join(dir, '4.jpg'))
  assert.equal(client.log[0], 'open https://shop.example/checkout')
  assert.equal(client.log[3], 'fill @e2 replaced')
})

test('a failed action still captures a frame and returns isError; a failed screenshot yields imagePath null', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-screens-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const captures: ScreenCapture[] = []
  const client = fakeClient({
    click: async () => { throw new Error('Element not found') },
    screenshotAnnotated: async () => { throw new Error('no display') },
  })
  const tools = browserTools({ client, screensDir: dir, onScreen: async (c) => { captures.push(c) } })
  const result = await call(tools, 'browser_click', { ref: 'e1', intent: 'x' })
  assert.equal(result.isError, true)
  assert.ok(result.content[0]!.text.includes('Element not found'))
  assert.equal(captures.length, 1)
  assert.equal(captures[0]!.imagePath, null)
})

test('browser_open rejects non-http URLs without capturing', async () => {
  const captures: ScreenCapture[] = []
  const tools = browserTools({ client: fakeClient(), screensDir: '/tmp', onScreen: async (c) => { captures.push(c) } })
  const result = await call(tools, 'browser_open', { url: 'file:///etc/passwd', intent: 'x' })
  assert.equal(result.isError, true)
  assert.equal(captures.length, 0)
})

test('a missing browser returns the install line without filing an empty frame', async () => {
  const captures: ScreenCapture[] = []
  const client = fakeClient({
    open: async () => { throw new Error('Browser unavailable: install agent-browser (npm i -g agent-browser)') },
  })
  const tools = browserTools({ client, screensDir: '/tmp', onScreen: async (c) => { captures.push(c) } })
  const result = await call(tools, 'browser_open', { url: 'https://example.com/', intent: 'read the heading' })
  assert.equal(result.isError, true)
  assert.ok(result.content[0]!.text.startsWith('Browser unavailable'))
  assert.equal(captures.length, 0, 'there is no browser to photograph, so no frame is filed')
})

test('a headed context forwards { headed: true } to client.open', async () => {
  const client = fakeClient()
  const tools = browserTools({ client, screensDir: '/tmp', onScreen: async () => {}, headed: true })
  await call(tools, 'browser_open', { url: 'https://shop.example/checkout', intent: 'open checkout' })
  assert.equal(client.log[0], 'open https://shop.example/checkout headed')
})
