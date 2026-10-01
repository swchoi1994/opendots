import { execFile } from 'node:child_process'
import { scrubbedEnv } from '../ai/claude-code'
import type { CommandRunner } from '../ai/tools/skills-sh'

/**
 * Typed wrapper over the `agent-browser` CLI: one isolated browser per bot
 * (`--session`), whose cookies and storage auto-persist across restarts
 * (`--session-name`). Every call is a short-lived CLI invocation against the
 * session's daemon; the daemon keeps the page alive between calls.
 */

export interface Annotation {
  number: number
  ref: string
  role: string
  name: string
  box: { x: number; y: number; width: number; height: number }
}

export interface BrowserClient {
  open(url: string, opts?: { headed?: boolean }): Promise<void>
  snapshot(opts?: { interactive?: boolean; compact?: boolean }): Promise<string>
  click(ref: string): Promise<void>
  type(ref: string, text: string): Promise<void>
  fill(ref: string, text: string): Promise<void>
  press(key: string): Promise<void>
  scroll(direction: 'up' | 'down' | 'left' | 'right', px?: number): Promise<void>
  back(): Promise<void>
  getUrl(): Promise<string>
  getTitle(): Promise<string>
  screenshotAnnotated(path: string): Promise<{ path: string; annotations: Annotation[] }>
  close(): Promise<void>
}

/**
 * What a bot sees when `agent-browser` is not installed at all.
 *
 * Spelled once and matched by prefix in `browser-tools.ts`, which skips its
 * screenshot when it sees it: there is no browser to photograph.
 */
export const BROWSER_UNAVAILABLE = 'Browser unavailable: install agent-browser (npm i -g agent-browser)'

export class BrowserCommandError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly stderr: string,
  ) {
    super(message)
    this.name = 'BrowserCommandError'
  }
}

const REF = /^@?e\d+$/

export function browserSessionName(channelUrl: string): string {
  return `bot_${channelUrl.replace(/[^A-Za-z0-9_-]+/g, '_')}`
}

export function normaliseRef(ref: string): string {
  const trimmed = ref.trim()
  if (!REF.test(trimmed)) throw new Error(`Invalid element ref "${ref}": expected a snapshot ref like @e4`)
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`
}

export function assertHttpUrl(url: string): string {
  let parsed: URL
  const trimmed = url.trim()
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`Invalid URL "${url}": only http(s) URLs can be opened`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refusing to open "${url}": only http(s) URLs can be opened`)
  }
  return trimmed
}

function timeoutMs(): number {
  const raw = Number.parseInt(process.env.OPENDOTS_BROWSER_TIMEOUT_MS ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000
}

/** Parses `OPENDOTS_BROWSER_VIEWPORT` ("WxH", default 1280x800); null on malformed input skips the resize. */
function parseViewport(): { width: number; height: number } | null {
  const raw = process.env.OPENDOTS_BROWSER_VIEWPORT ?? '1280x800'
  const match = /^(\d+)x(\d+)$/.exec(raw.trim())
  if (!match) return null
  const width = Number.parseInt(match[1]!, 10)
  const height = Number.parseInt(match[2]!, 10)
  return width > 0 && height > 0 ? { width, height } : null
}

/** Parses `OPENDOTS_SCREENSHOT_QUALITY` (an integer 1..100, default 70); anything else falls back. */
function screenshotQuality(): number {
  const raw = Number.parseInt(process.env.OPENDOTS_SCREENSHOT_QUALITY ?? '', 10)
  return Number.isInteger(raw) && raw >= 1 && raw <= 100 ? raw : 70
}

const defaultRunner: CommandRunner = (cmd, args, { cwd, timeoutMs }) =>
  new Promise((resolve) => {
    execFile(cmd, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      // scrubbedEnv keeps only PATH/HOME (plus a few others) so a bot with `shell` or
      // `web_browser` granted never inherits DATABASE_URL and friends; agent-browser
      // needs HOME (for ~/.agent-browser) and PATH, both in the allowlist. The cast is
      // Next's doing: it augments NODE_ENV to a literal union, which scrubbedEnv's
      // plain Record<string, string> does not satisfy structurally.
      env: { ...scrubbedEnv(process.env), NO_COLOR: '1' } as unknown as NodeJS.ProcessEnv,
    }, (error, stdout, stderr) => {
      // A missing binary is not a page-level failure the bot could retry its way
      // out of, and Node reports it as ENOENT rather than an exit status. Map it
      // onto 127 ("command not found") so `run` can name it precisely.
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ code: 127, stdout: '', stderr: BROWSER_UNAVAILABLE })
        return
      }
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) + (error && !stderr ? `\n${error.message}` : '') })
    })
  })

interface CliEnvelope<T> {
  success?: boolean
  data?: T
  error?: string | null
}

export function browserFor(
  channelUrl: string,
  deps: { runner?: CommandRunner; bin?: string } = {},
): BrowserClient {
  const runner = deps.runner ?? defaultRunner
  const bin = deps.bin ?? process.env.AGENT_BROWSER_BIN ?? 'agent-browser'
  const session = browserSessionName(channelUrl)
  const base = ['--session', session, '--session-name', session]

  async function run<T = Record<string, unknown>>(args: string[], opts: { timeout?: number } = {}): Promise<T> {
    const { code, stdout, stderr } = await runner(bin, [...base, ...args, '--json'], {
      cwd: process.cwd(),
      timeoutMs: opts.timeout ?? timeoutMs(),
    })
    // 127 is "the binary is not there": every command would fail the same way,
    // so it gets the actionable message rather than a per-command stderr tail.
    if (code === 127) throw new BrowserCommandError(BROWSER_UNAVAILABLE, 127, stderr)
    if (code !== 0) {
      throw new BrowserCommandError(`agent-browser ${args[0]} failed (${code}): ${(stderr || stdout).trim().slice(-500)}`, code, stderr)
    }
    let parsed: CliEnvelope<T>
    try {
      parsed = JSON.parse(stdout) as CliEnvelope<T>
    } catch {
      // Some subcommands print plain text even with --json; treat that as data.
      return { text: stdout } as unknown as T
    }
    if (parsed.success === false) {
      throw new BrowserCommandError(`agent-browser ${args[0]} failed: ${parsed.error ?? 'unknown error'}`, 1, parsed.error ?? '')
    }
    return (parsed.data ?? {}) as T
  }

  return {
    async open(url, opts = {}) {
      const safe = assertHttpUrl(url)
      await run(['open', safe, ...(opts.headed ? ['--headed'] : [])], { timeout: timeoutMs() * 2 })
      const viewport = parseViewport()
      if (viewport) {
        // Best-effort: a bad viewport setting must never fail the navigation that already succeeded.
        await run(['set', 'viewport', String(viewport.width), String(viewport.height)]).catch(() => undefined)
      }
    },
    async snapshot(opts = {}) {
      const flags = [...(opts.interactive ? ['-i'] : []), ...(opts.compact ? ['-c'] : [])]
      const data = await run<{ snapshot?: string; text?: string }>(['snapshot', ...flags])
      return (data.snapshot ?? data.text ?? '').trim()
    },
    async click(ref) {
      await run(['click', normaliseRef(ref)])
    },
    async type(ref, text) {
      await run(['type', normaliseRef(ref), text])
    },
    async fill(ref, text) {
      await run(['fill', normaliseRef(ref), text])
    },
    async press(key) {
      if (!/^[A-Za-z0-9+]+$/.test(key)) throw new Error(`Invalid key "${key}"`)
      await run(['press', key])
    },
    async scroll(direction, px) {
      await run(['scroll', direction, ...(px ? [String(Math.max(1, Math.min(5000, Math.floor(px))))] : [])])
    },
    async back() {
      await run(['back'])
    },
    async getUrl() {
      const data = await run<{ url?: string }>(['get', 'url'])
      return data.url ?? ''
    },
    async getTitle() {
      const data = await run<{ title?: string }>(['get', 'title'])
      return data.title ?? ''
    },
    async screenshotAnnotated(path) {
      const data = await run<{ path?: string; annotations?: Annotation[] }>([
        'screenshot', path, '--annotate', '--screenshot-format', 'jpeg',
        '--screenshot-quality', String(screenshotQuality()),
      ])
      return { path: data.path ?? path, annotations: Array.isArray(data.annotations) ? data.annotations : [] }
    },
    async close() {
      await run(['close']).catch(() => undefined)
    },
  }
}
