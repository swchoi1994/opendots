'use client'

import { useState } from 'react'

/**
 * Mints (or re-reveals) the share link for a conversation.
 *
 * The id is stable per conversation, so pressing Deploy twice returns the same
 * URL rather than invalidating links already sent to people.
 */
export function DeployButton({ channelUrl }: { channelUrl: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [passcode, setPasscode] = useState<string | null>(null)
  const [isDeploying, setIsDeploying] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function deploy() {
    setIsDeploying(true)
    setError(null)
    try {
      const response = await fetch(`/api/channels/${channelUrl}/deploy`, { method: 'POST' })
      if (!response.ok) {
        setError('Could not deploy')
        return
      }
      const body = (await response.json()) as {
        url: string
        deployment: { passcode: string }
      }
      setUrl(body.url)
      setPasscode(body.deployment.passcode)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not deploy')
    } finally {
      setIsDeploying(false)
    }
  }

  async function copy() {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be denied; the link stays visible and selectable.
      setError('Copy blocked — select the link manually')
    }
  }

  if (url) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="max-w-[280px] truncate rounded-full bg-brand-50 px-2.5 py-1 font-mono text-[11px] text-brand-700 hover:underline"
          title={url}
        >
          {url.replace(/^https?:\/\//, '')}
        </a>
        {/* The passcode is what makes the link shareable rather than public. */}
        {passcode && (
          <span
            className="shrink-0 rounded-full bg-amber-50 px-2 py-1 font-mono text-[11px] font-semibold tracking-wider text-amber-800"
            title="Visitors must enter this passcode"
          >
            {passcode}
          </span>
        )}
        <button
          type="button"
          onClick={copy}
          className="shrink-0 cursor-pointer rounded-full px-2 py-1 text-[11px] font-semibold text-ink-700 transition-colors hover:bg-line"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </span>
    )
  }

  return (
    <span className="flex items-center gap-2">
      {error && <span className="text-[11px] text-rose-700">{error}</span>}
      <button
        type="button"
        onClick={deploy}
        disabled={isDeploying}
        className="cursor-pointer rounded-full bg-brand-500 px-3 py-1 text-[12px] font-semibold text-white transition-colors hover:bg-brand-600 disabled:opacity-50"
      >
        {isDeploying ? 'Deploying…' : 'Deploy'}
      </button>
    </span>
  )
}
