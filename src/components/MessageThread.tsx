'use client'

import { useEffect, useRef } from 'react'
import { MessageBubble } from './MessageBubble'
import { RespondingBubble } from './RespondingBubble'
import type { RespondingState } from '@/hooks/useChat'
import type { Screen } from '@/lib/domain/screen'
import type { MessageWithReceipt } from '@/lib/domain/types'
import { formatTime } from '@/lib/format'

interface MessageThreadProps {
  messages: MessageWithReceipt[]
  isLoading: boolean
  responding?: RespondingState | null
  /** Set by search; the message is scrolled to and briefly highlighted. */
  highlightMessageId?: number | null
  /** All persisted frames for this channel, matched to replies by `messageId`. */
  screens?: Screen[]
  onOpenScreen?: (screenId: number) => void
}

/** A time separator appears before the first message, and again after a gap this long. */
const GAP_MS = 30 * 60 * 1000

export function MessageThread({
  messages,
  isLoading,
  responding,
  highlightMessageId,
  screens = [],
  onOpenScreen,
}: MessageThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const lastMessageId = messages.at(-1)?.message.messageId
  const respondingLength = responding?.text.length ?? -1
  const respondingScreenCount = responding?.screens.length ?? 0

  // Keyed on the last message id rather than the array: re-fetching the same
  // thread produces a new array every time and would re-scroll on every poll.
  // Streaming length is included so the view follows tokens as they arrive;
  // screen count too, so a live frame captured before any token still pulls
  // the thread down to reveal its thumbnail.
  useEffect(() => {
    // Jumping to a search hit must not be immediately undone by the
    // scroll-to-bottom effect, so that jump owns the scroll while it is active.
    if (highlightMessageId != null) return
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [lastMessageId, respondingLength, respondingScreenCount, highlightMessageId])

  useEffect(() => {
    if (highlightMessageId == null) return
    const target = document.getElementById(`message-${highlightMessageId}`)
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [highlightMessageId])

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-[13px] text-ink-500">Loading messages…</p>
      </div>
    )
  }

  if (messages.length === 0 && !responding) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-[13px] text-ink-500">No messages in this channel yet.</p>
      </div>
    )
  }

  return (
    <div className="thread-scroll min-h-0 flex-1 overflow-y-auto px-6 py-5">
      {/* Capped and centred: on an ultrawide monitor a full-bleed thread throws
          the eye across the screen between the avatar and the timestamp. */}
      <ol className="mx-auto flex w-full max-w-[900px] flex-col gap-2">
        {messages.map((entry, index) => {
          const previous = messages[index - 1]
          const showSender = previous?.message.sender.userId !== entry.message.sender.userId
          const showTime = !previous || entry.message.createdAt - previous.message.createdAt > GAP_MS
          const isHighlighted = entry.message.messageId === highlightMessageId
          return (
            <li
              key={entry.message.messageId}
              id={`message-${entry.message.messageId}`}
              className={
                isHighlighted ? 'rounded-xl bg-amber-50 ring-2 ring-amber-300 transition-colors' : ''
              }
            >
              {showTime && (
                <p className="mb-1 text-center text-[12px] text-ink-500">{formatTime(entry.message.createdAt)}</p>
              )}
              <MessageBubble
                entry={entry}
                showSender={showSender}
                screens={screens.filter((s) => s.messageId === entry.message.messageId)}
                onOpenScreen={onOpenScreen}
              />
            </li>
          )
        })}
        {responding && (
          <li>
            <RespondingBubble
              text={responding.text}
              provenance={responding.provenance}
              activity={responding.activity}
              installedSkills={responding.installedSkills}
              screens={responding.screens}
              onOpenScreen={onOpenScreen}
            />
          </li>
        )}
      </ol>
      <div ref={bottomRef} />
    </div>
  )
}
