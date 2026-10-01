'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'

interface PasscodeGateProps {
  deploymentId: string
  /** Safe to show while locked: the name is on the share link's own card. */
  channelName: string
}

export function PasscodeGate({ deploymentId, channelName }: PasscodeGateProps) {
  const router = useRouter()
  const [passcode, setPasscode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!passcode.trim() || isSubmitting) return

    setIsSubmitting(true)
    setError(null)
    try {
      const response = await fetch(`/api/deployments/${deploymentId}/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode }),
      })

      if (!response.ok) {
        setError('Incorrect passcode')
        return
      }

      // The gate is decided server-side, so re-render from the server rather
      // than flipping a local flag the server never agreed to.
      router.refresh()
    } catch {
      setError('Could not verify the passcode')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="flex h-screen w-full items-center justify-center bg-brand-50 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <h1 className="text-[18px] font-bold text-ink-900">{channelName}</h1>
        <p className="mt-1 text-[13px] text-ink-500">
          This conversation is shared with a passcode. Enter it to continue.
        </p>

        <form onSubmit={handleSubmit} className="mt-5 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-semibold text-ink-700">Passcode</span>
            <input
              type="text"
              value={passcode}
              onChange={(event) => setPasscode(event.target.value)}
              autoComplete="off"
              autoFocus
              spellCheck={false}
              className="rounded-lg border border-line px-3 py-2 font-mono text-[15px] tracking-[0.2em] uppercase outline-none focus:border-brand-500"
            />
          </label>

          {error && (
            <p role="alert" className="text-[12px] text-rose-700">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={!passcode.trim() || isSubmitting}
            className="cursor-pointer rounded-lg bg-brand-500 px-4 py-2 text-[14px] font-semibold text-white transition-colors hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isSubmitting ? 'Checking…' : 'Unlock'}
          </button>
        </form>
      </div>
    </main>
  )
}
