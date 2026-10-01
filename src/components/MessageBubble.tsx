import { ImagePlaceholderIcon, ReadReceiptIcon, SentReceiptIcon } from './icons'
import { MessageMarkdown } from './MessageMarkdown'
import { ScreenStrip } from './ScreenStrip'
import {
  CURRENT_USER_ID,
  type MessageProvenance,
  type MessageWithReceipt,
} from '@/lib/domain/types'
import { isUserMessage } from '@/lib/domain/types'
import { formatTime } from '@/lib/format'
import type { Screen } from '@/lib/domain/screen'

function FilePlaceholder({ name }: { name: string }) {
  return (
    <div className="flex h-[290px] w-[400px] max-w-full flex-col items-center justify-center gap-2 rounded-2xl bg-gradient-to-b from-brand-200 to-brand-100 text-brand-700">
      <ImagePlaceholderIcon className="h-28 w-28 opacity-70" />
      <p className="text-[13px] font-medium">{name}</p>
      <p className="text-[11px] opacity-70">placeholder attachment</p>
    </div>
  )
}

/**
 * States plainly whether an answer was grounded in uploaded skills or produced
 * from the model's own knowledge — the distinction a reader needs in order to
 * decide how much to trust it.
 */
export function ProvenanceNote({ provenance }: { provenance: MessageProvenance }) {
  const { usedSkills, usedBuiltInKnowledge } = provenance
  const grounded = usedSkills.length > 0 || usedBuiltInKnowledge

  return (
    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-500">
      {grounded ? (
        <>
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-800">
            {usedSkills.length > 0 ? 'Used skills' : 'Used knowledge base'}
          </span>
          {usedSkills.map((skill) => (
            <span key={skill.id} className="rounded-full bg-brand-50 px-2 py-0.5 text-brand-700">
              {skill.title}
            </span>
          ))}
          {usedSkills.length > 0 && usedBuiltInKnowledge && (
            <span className="rounded-full bg-brand-50 px-2 py-0.5 text-brand-700">
              knowledge base
            </span>
          )}
        </>
      ) : (
        <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-800">
          Own knowledge — no passages retrieved
        </span>
      )}
    </p>
  )
}

interface MessageBubbleProps {
  entry: MessageWithReceipt
  /** False when the previous message came from the same sender. */
  showSender: boolean
  /** This reply's captured browser frames, if any (bot messages only). */
  screens?: Screen[]
  onOpenScreen?: (screenId: number) => void
}

export function MessageBubble({ entry, screens = [], onOpenScreen }: MessageBubbleProps) {
  const { message, unreadMemberCount } = entry
  const isOwn = message.sender.userId === CURRENT_USER_ID
  const time = formatTime(message.createdAt)
  const isRead = unreadMemberCount === 0

  const body = isUserMessage(message) ? (
    <div
      className={`max-w-[560px] rounded-[18px] px-4 py-2.5 text-[15px] leading-relaxed break-words ${
        isOwn ? 'bg-bubble-own text-white whitespace-pre-wrap' : 'bg-bubble text-ink-900'
      }`}
    >
      {/* People type plain text (keep their line breaks); bots answer in Markdown. */}
      {isOwn ? message.message : <MessageMarkdown text={message.message} />}
    </div>
  ) : (
    <FilePlaceholder name={message.name} />
  )

  if (isOwn) {
    return (
      <div className="flex justify-end">
        <div className="flex items-end gap-2">
          <div className="flex items-center gap-1.5 pb-1">
            {/*
              One grey check once the message is stored, two green checks once
              every other member (the assistant included) has read it — the
              convention people already know from messaging apps.
            */}
            {isRead ? (
              <ReadReceiptIcon className="h-4 w-4 text-read" aria-label="Read" />
            ) : (
              <SentReceiptIcon className="h-4 w-4 text-ink-400" aria-label="Sent" />
            )}
            <time className="text-[12px] text-ink-500" dateTime={new Date(message.createdAt).toISOString()}>
              {time}
            </time>
          </div>
          {body}
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-end gap-2">
      <div className="min-w-0">
        {body}
        {message.provenance && <ProvenanceNote provenance={message.provenance} />}
        {screens.length > 0 && <ScreenStrip screens={screens} onOpen={onOpenScreen ?? (() => {})} />}
      </div>
      <time className="pb-1 text-[12px] text-ink-500" dateTime={new Date(message.createdAt).toISOString()}>
        {time}
      </time>
    </div>
  )
}
