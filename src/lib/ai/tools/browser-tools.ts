import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { assertHttpUrl, normaliseRef, type Annotation, type BrowserClient } from '../../browser/agent-browser'

/**
 * Browser tools for the opendots MCP server.
 *
 * Every acting tool runs the action, then the SERVER captures an annotated
 * screenshot and reports it through `onScreen`. The bot never has to remember
 * to look; the timeline is complete by construction. Tools return the
 * interactive accessibility snapshot so the model always knows the page.
 */

export interface ScreenCapture {
  step: number
  action: string
  target: string | null
  intent: string | null
  url: string
  title: string
  imagePath: string | null
  annotations: Annotation[]
  flagged: boolean
}

export interface BrowserToolsContext {
  client: BrowserClient
  /** Directory for this turn's frames; created on first capture. */
  screensDir: string
  onScreen: (capture: ScreenCapture) => Promise<void>
  /** Run the browser with a visible window instead of headless. */
  headed?: boolean
}

const FLAGGED = /\b(pay|purchase|buy|checkout|place order|order now|delete|remove|send|submit|confirm|transfer|unsubscribe)\b/i

export function isFlaggedTarget(name: string | null | undefined): boolean {
  return Boolean(name && FLAGGED.test(name))
}

function text(value: string, isError = false) {
  return { content: [{ type: 'text' as const, text: value }], ...(isError ? { isError: true } : {}) }
}

/** Finds the accessible name of a ref in a snapshot line like `- button "Pay now" [ref=e7]`. */
export function nameForRef(snapshot: string, ref: string): string | null {
  const bare = ref.replace(/^@/, '')
  const line = snapshot.split('\n').find((l) => l.includes(`[ref=${bare}]`) || l.includes(`ref=${bare},`) || l.includes(`ref=${bare}]`))
  const match = line ? /"([^"]*)"/.exec(line) : null
  return match?.[1] ?? null
}

export function browserTools(ctx: BrowserToolsContext) {
  let step = 0
  let lastSnapshot = ''

  async function page(): Promise<{ url: string; title: string; snapshot: string }> {
    const [url, title, snapshot] = await Promise.all([
      ctx.client.getUrl().catch(() => ''),
      ctx.client.getTitle().catch(() => ''),
      ctx.client.snapshot({ interactive: true, compact: true }).catch(() => ''),
    ])
    lastSnapshot = snapshot
    return { url, title, snapshot }
  }

  function describe(p: { url: string; title: string; snapshot: string }): string {
    return `URL: ${p.url}\nTitle: ${p.title}\n\nInteractive elements (act on @refs):\n${p.snapshot || '(empty page)'}`
  }

  async function capture(action: string, target: string | null, intent: string | null, targetName: string | null) {
    step += 1
    const p = await page()
    let imagePath: string | null = null
    let annotations: Annotation[] = []
    try {
      mkdirSync(ctx.screensDir, { recursive: true })
      const path = join(ctx.screensDir, `${step}.jpg`)
      const shot = await ctx.client.screenshotAnnotated(path)
      // The path we asked the CLI to write, not the one it echoed back: this is
      // what the image route later reads off disk, so it has to be ours.
      imagePath = path
      annotations = shot.annotations
    } catch {
      // A missing screenshot must never fail the action; the frame records the URL.
    }
    await ctx.onScreen({
      step, action, target, intent, url: p.url, title: p.title, imagePath, annotations,
      flagged: isFlaggedTarget(targetName),
    })
    return p
  }

  /** Runs an action, always captures, returns the page description or an error. */
  async function act(action: string, intent: string, target: string | null, fn: () => Promise<void>) {
    const targetName = target ? nameForRef(lastSnapshot, target) : null
    let failure: string | null = null
    try {
      await fn()
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : String(cause)
      /*
       * No browser on this machine: there is nothing to photograph and nothing
       * to read, so capturing would file one empty frame per attempted action
       * and bury the one thing the operator needs to know. The bot gets the
       * install line and carries on without the tool.
       */
      if (failure.startsWith('Browser unavailable')) return text(failure, true)
    }
    const p = await capture(action, target, intent, targetName)
    if (failure) return text(`${action} failed: ${failure}\n\n${describe(p)}`, true)
    return text(describe(p))
  }

  const intent = z.string().min(1).describe('One line on why you are doing this; the user sees it in the timeline')

  return [
    tool('browser_open', 'Open a web page in your own browser. Returns the URL, title, and interactive elements with @refs. A screenshot is captured automatically after the page loads — you do not need to take one yourself.',
      { url: z.string().url(), intent },
      async ({ url, intent }) => {
        try {
          assertHttpUrl(url)
        } catch (cause) {
          return text(cause instanceof Error ? cause.message : String(cause), true)
        }
        return act('open', intent, null, () => ctx.client.open(url, { headed: ctx.headed }))
      }),
    tool('browser_snapshot', 'Re-read the current page as an accessibility tree with @refs. No screenshot is taken; use this to refresh your view of the page without adding a frame to the timeline.',
      { interactive: z.boolean().optional().describe('Only interactive elements (default true)') },
      async ({ interactive }) => {
        const snapshot = await ctx.client.snapshot({ interactive: interactive ?? true, compact: true }).catch((e: Error) => `snapshot failed: ${e.message}`)
        lastSnapshot = snapshot
        return text(snapshot || '(empty page)')
      }, { annotations: { readOnlyHint: true } }),
    tool('browser_click', 'Click an element by its @ref from the latest snapshot. A screenshot is captured automatically after the click; you must pass a truthful one-line `intent` describing why, since the user sees it in the timeline.',
      { ref: z.string(), intent },
      async ({ ref, intent }) => {
        let safe: string
        try { safe = normaliseRef(ref) } catch (cause) { return text(cause instanceof Error ? cause.message : String(cause), true) }
        return act('click', intent, safe, () => ctx.client.click(safe))
      }),
    tool('browser_type', 'Type text into an element (appends to existing content). A screenshot is captured automatically afterward; `intent` is required and shown to the user.',
      { ref: z.string(), text: z.string(), intent },
      async ({ ref, text: value, intent }) => {
        let safe: string
        try { safe = normaliseRef(ref) } catch (cause) { return text(cause instanceof Error ? cause.message : String(cause), true) }
        return act('type', intent, safe, () => ctx.client.type(safe, value))
      }),
    tool('browser_fill', 'Clear an input and fill it with text. A screenshot is captured automatically afterward; `intent` is required and shown to the user.',
      { ref: z.string(), text: z.string(), intent },
      async ({ ref, text: value, intent }) => {
        let safe: string
        try { safe = normaliseRef(ref) } catch (cause) { return text(cause instanceof Error ? cause.message : String(cause), true) }
        return act('fill', intent, safe, () => ctx.client.fill(safe, value))
      }),
    tool('browser_press', 'Press a keyboard key such as Enter, Tab, Escape, or Control+a. A screenshot is captured automatically afterward; `intent` is required and shown to the user.',
      { key: z.string().regex(/^[A-Za-z0-9+]+$/), intent },
      async ({ key, intent }) => act('press', intent, null, () => ctx.client.press(key))),
    tool('browser_scroll', 'Scroll the page. A screenshot is captured automatically afterward; `intent` is required and shown to the user.',
      { direction: z.enum(['up', 'down', 'left', 'right']), px: z.number().int().positive().max(5000).optional(), intent },
      async ({ direction, px, intent }) => act('scroll', intent, null, () => ctx.client.scroll(direction, px))),
    tool('browser_back', 'Go back to the previous page. A screenshot is captured automatically afterward; `intent` is required and shown to the user.',
      { intent },
      async ({ intent }) => act('back', intent, null, () => ctx.client.back())),
  ]
}
