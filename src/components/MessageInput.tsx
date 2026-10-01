'use client'

import { useState, type FormEvent } from 'react'
import { MicIcon, PlusIcon, SendIcon } from './icons'

interface MessageInputProps {
  disabled: boolean
  isSending: boolean
  onSend: (text: string) => void | Promise<void>
  placeholder?: string
  botName?: string
}

export function MessageInput({ disabled, isSending, onSend, placeholder, botName }: MessageInputProps) {
  const [value, setValue] = useState('')
  const canSend = value.trim().length > 0 && !disabled && !isSending

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSend) return
    const text = value
    setValue('')
    await onSend(text)
  }

  return (
    <form onSubmit={handleSubmit} className="shrink-0 border-t border-line px-6 py-4">
      <div className="mx-auto flex w-full max-w-[900px] items-center gap-2 rounded-full border border-line bg-white px-3 py-2">
        <button
          type="button"
          disabled={disabled}
          aria-label="Attach file"
          className="flex shrink-0 cursor-pointer items-center justify-center rounded-full bg-surface p-1.5 text-ink-700 transition-colors hover:bg-line disabled:cursor-not-allowed disabled:opacity-40"
        >
          <PlusIcon className="h-4 w-4" />
        </button>

        <input
          type="text"
          value={value}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
          placeholder={placeholder ?? `Message ${botName ?? ''}`.trim()}
          aria-label="Message"
          className="min-w-0 flex-1 bg-transparent text-[15px] text-ink-900 outline-none placeholder:text-ink-400 disabled:cursor-not-allowed"
        />

        {value.trim().length > 0 ? (
          /*
            Explicit submit control. Enter alone is a keyboard-only affordance —
            pointer and assistive-tech users need a real button to reach send.
          */
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send message"
            className="cursor-pointer rounded-full bg-brand-500 p-1.5 text-white transition-opacity hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <SendIcon className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            disabled
            title="Voice arrives later"
            aria-label="Record voice message"
            className="cursor-not-allowed rounded-full p-1.5 text-ink-400 opacity-60"
          >
            <MicIcon className="h-5 w-5" />
          </button>
        )}
      </div>
    </form>
  )
}
