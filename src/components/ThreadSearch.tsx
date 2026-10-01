'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { CloseIcon, SearchIcon } from './icons'
import { formatTime } from '@/lib/format'
import { isUserMessage, type MessageWithReceipt } from '@/lib/domain/types'

interface ThreadSearchProps {
  messages: MessageWithReceipt[]
  onClose: () => void
  onJumpTo: (messageId: number) => void
}

interface Hit {
  messageId: number
  sender: string
  createdAt: number
  /** Text around the match, so a hit is recognisable without opening it. */
  snippet: string
}

const SNIPPET_RADIUS = 40

function buildSnippet(text: string, matchIndex: number, queryLength: number): string {
  const start = Math.max(0, matchIndex - SNIPPET_RADIUS)
  const end = Math.min(text.length, matchIndex + queryLength + SNIPPET_RADIUS)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/**
 * In-conversation message search.
 *
 * Substring matching over the loaded thread rather than the RAG retriever:
 * someone looking for "the message where Priya mentioned the schema" wants a
 * literal find, not a semantic ranking that might not surface the exact line.
 */
/**
 * Rendered only while open, so closing unmounts it and the query resets on its
 * own. Clearing state from an effect would be doing by hand what unmounting
 * already does — and React Compiler rightly flags it.
 */
export function ThreadSearch({ messages, onClose, onJumpTo }: ThreadSearchProps) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const hits = useMemo<Hit[]>(() => {
    const needle = query.trim().toLowerCase()
    if (needle.length < 2) return []

    const found: Hit[] = []
    for (const { message } of messages) {
      const text = isUserMessage(message) ? message.message : message.name
      const index = text.toLowerCase().indexOf(needle)
      if (index === -1) continue
      found.push({
        messageId: message.messageId,
        sender: message.sender.nickname,
        createdAt: message.createdAt,
        snippet: buildSnippet(text, index, needle.length),
      })
    }
    // Newest first: recent messages are what people are usually looking for.
    return found.reverse()
  }, [messages, query])

  return (
    <div className="shrink-0 border-b border-line bg-brand-50/60">
      <div className="flex items-center gap-2 px-6 py-2.5">
        <SearchIcon className="h-4 w-4 shrink-0 text-ink-500" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search this conversation"
          aria-label="Search this conversation"
          className="min-w-0 flex-1 bg-transparent text-[14px] text-ink-900 outline-none placeholder:text-ink-400"
        />
        <span className="shrink-0 text-[12px] text-ink-500">
          {query.trim().length < 2 ? '' : `${hits.length} result${hits.length === 1 ? '' : 's'}`}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close search"
          className="shrink-0 cursor-pointer rounded-full p-1 text-ink-500 transition-colors hover:bg-line"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      {hits.length > 0 && (
        <ul className="max-h-64 overflow-y-auto border-t border-line">
          {hits.map((hit) => (
            <li key={hit.messageId}>
              <button
                type="button"
                onClick={() => onJumpTo(hit.messageId)}
                className="flex w-full cursor-pointer flex-col gap-0.5 border-b border-line px-6 py-2 text-left transition-colors last:border-b-0 hover:bg-white"
              >
                <span className="flex items-baseline gap-2">
                  <span className="text-[12px] font-semibold text-ink-900">{hit.sender}</span>
                  <span className="text-[11px] text-ink-500">{formatTime(hit.createdAt)}</span>
                </span>
                <span className="line-clamp-2 text-[12px] text-ink-700">{hit.snippet}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
