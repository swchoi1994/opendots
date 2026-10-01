import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertHttpUrl, browserFor, browserSessionName, normaliseRef, BROWSER_UNAVAILABLE, BrowserCommandError } from './agent-browser'

type Call = { cmd: string; args: string[]; timeoutMs: number }
function fakeRunner(reply: (args: string[]) => string) {
  const calls: Call[] = []
  const runner = async (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => {
    calls.push({ cmd, args, timeoutMs: opts.timeoutMs })
    return { code: 0, stdout: reply(args), stderr: '' }
  }
  return { calls, runner }
}

test('browserSessionName derives from the channel url only', () => {
  assert.equal(browserSessionName('bot_chief-of-staff'), 'bot_bot_chief-of-staff')
  assert.equal(browserSessionName('a/b c'), 'bot_a_b_c')
})

test('normaliseRef and assertHttpUrl reject unsafe input', () => {
  assert.equal(normaliseRef('e4'), '@e4')
  assert.equal(normaliseRef('@e12'), '@e12')
  assert.throws(() => normaliseRef('body > a'), /ref/)
  assert.equal(assertHttpUrl('https://example.com/x'), 'https://example.com/x')
  assert.throws(() => assertHttpUrl('file:///etc/passwd'), /http/)
  assert.throws(() => assertHttpUrl('javascript:alert(1)'), /http/)
})

test('every command carries the session flags and --json, open is headless unless asked', async () => {
  const { calls, runner } = fakeRunner(() => JSON.stringify({ success: true, data: {} }))
  const browser = browserFor('bot_x', { runner, bin: 'agent-browser' })
  await browser.open('https://example.com')
  await browser.click('e3')
  await browser.open('https://example.com', { headed: true })
  for (const call of calls) {
    assert.equal(call.cmd, 'agent-browser')
    assert.deepEqual(call.args.slice(0, 4), ['--session', 'bot_bot_x', '--session-name', 'bot_bot_x'])
    assert.ok(call.args.includes('--json'))
  }
  // open is followed by a best-effort viewport resize (OPENDOTS_BROWSER_VIEWPORT, default 1280x800).
  assert.deepEqual(calls[0]!.args.slice(4), ['open', 'https://example.com', '--json'])
  assert.deepEqual(calls[1]!.args.slice(4), ['set', 'viewport', '1280', '800', '--json'])
  assert.deepEqual(calls[2]!.args.slice(4), ['click', '@e3', '--json'])
  assert.deepEqual(calls[3]!.args.slice(4), ['open', 'https://example.com', '--headed', '--json'])
  assert.deepEqual(calls[4]!.args.slice(4), ['set', 'viewport', '1280', '800', '--json'])
  assert.equal(calls[0]!.timeoutMs, 60_000)
  assert.equal(calls[2]!.timeoutMs, 30_000)
})

test('open resizes to OPENDOTS_BROWSER_VIEWPORT, skips the resize on malformed input', async () => {
  const original = process.env.OPENDOTS_BROWSER_VIEWPORT
  try {
    process.env.OPENDOTS_BROWSER_VIEWPORT = '1440x900'
    const { calls, runner } = fakeRunner(() => JSON.stringify({ success: true, data: {} }))
    const browser = browserFor('bot_x', { runner })
    await browser.open('https://example.com')
    assert.deepEqual(calls[1]!.args.slice(4), ['set', 'viewport', '1440', '900', '--json'])

    process.env.OPENDOTS_BROWSER_VIEWPORT = 'not-a-size'
    const { calls: calls2, runner: runner2 } = fakeRunner(() => JSON.stringify({ success: true, data: {} }))
    const browser2 = browserFor('bot_y', { runner: runner2 })
    await browser2.open('https://example.com')
    assert.equal(calls2.length, 1)
  } finally {
    if (original === undefined) delete process.env.OPENDOTS_BROWSER_VIEWPORT
    else process.env.OPENDOTS_BROWSER_VIEWPORT = original
  }
})

test('snapshot returns the tree text, getUrl/getTitle unwrap data, screenshot parses annotations', async () => {
  const { runner } = fakeRunner((args) => {
    if (args[4] === 'snapshot') return JSON.stringify({ success: true, data: { snapshot: '- heading "Example" [ref=e1]' } })
    if (args[4] === 'get' && args[5] === 'url') return JSON.stringify({ success: true, data: { url: 'https://example.com/' } })
    if (args[4] === 'get' && args[5] === 'title') return JSON.stringify({ success: true, data: { title: 'Example' } })
    if (args[4] === 'screenshot') return JSON.stringify({ success: true, data: { path: '/tmp/s.jpg', annotations: [{ number: 1, ref: 'e1', role: 'heading', name: 'Example', box: { x: 1, y: 2, width: 3, height: 4 } }] } })
    return JSON.stringify({ success: true, data: {} })
  })
  const browser = browserFor('bot_x', { runner })
  assert.equal(await browser.snapshot({ interactive: true }), '- heading "Example" [ref=e1]')
  assert.equal(await browser.getUrl(), 'https://example.com/')
  assert.equal(await browser.getTitle(), 'Example')
  const shot = await browser.screenshotAnnotated('/tmp/s.jpg')
  assert.equal(shot.annotations[0]?.ref, 'e1')
  assert.equal(shot.annotations[0]?.name, 'Example')
})

test('screenshot quality is validated like the viewport: integer 1..100, else 70', async () => {
  const original = process.env.OPENDOTS_SCREENSHOT_QUALITY
  const qualityArg = async (value: string | undefined) => {
    if (value === undefined) delete process.env.OPENDOTS_SCREENSHOT_QUALITY
    else process.env.OPENDOTS_SCREENSHOT_QUALITY = value
    const { calls, runner } = fakeRunner(() => JSON.stringify({ success: true, data: {} }))
    await browserFor('bot_x', { runner }).screenshotAnnotated('/tmp/s.jpg')
    const args = calls[0]!.args
    return args[args.indexOf('--screenshot-quality') + 1]
  }
  try {
    assert.equal(await qualityArg(undefined), '70')
    assert.equal(await qualityArg('50'), '50')
    assert.equal(await qualityArg('0'), '70', 'below the range falls back')
    assert.equal(await qualityArg('101'), '70', 'above the range falls back')
    assert.equal(await qualityArg('high'), '70', 'nonsense falls back')
  } finally {
    if (original === undefined) delete process.env.OPENDOTS_SCREENSHOT_QUALITY
    else process.env.OPENDOTS_SCREENSHOT_QUALITY = original
  }
})

test('a failing command throws BrowserCommandError with stderr', async () => {
  const runner = async () => ({ code: 1, stdout: '', stderr: 'Element not found' })
  const browser = browserFor('bot_x', { runner })
  await assert.rejects(browser.click('e9'), /Element not found/)
})

test('a missing binary (exit 127) is reported as an install instruction, not a page failure', async () => {
  // The real runner maps ENOENT onto 127; here the runner stands in for that.
  const runner = async () => ({ code: 127, stdout: '', stderr: BROWSER_UNAVAILABLE })
  const browser = browserFor('bot_x', { runner })
  await assert.rejects(
    browser.open('https://example.com'),
    (error: unknown) => {
      assert.ok(error instanceof BrowserCommandError)
      assert.equal(error.message, 'Browser unavailable: install agent-browser (npm i -g agent-browser)')
      assert.equal(error.code, 127)
      return true
    },
  )
})
