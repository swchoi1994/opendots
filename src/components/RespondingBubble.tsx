import { ProvenanceNote } from './MessageBubble'
import { MessageMarkdown } from './MessageMarkdown'
import { ScreenStrip } from './ScreenStrip'
import { ToolActivity } from './ToolActivity'
import type { ToolActivityState } from '@/hooks/useChat'
import type { ScreenFrame } from '@/lib/domain/screen'
import type { MessageProvenance } from '@/lib/domain/types'

interface RespondingBubbleProps {
  /** Tokens received so far; empty means the model has not started emitting. */
  text: string
  provenance: MessageProvenance | null
  activity: ToolActivityState | null
  installedSkills: string[]
  /** Frames captured so far this turn, streamed in as the bot browses. */
  screens?: ScreenFrame[]
  onOpenScreen?: (screenId: number) => void
}

/**
 * The in-flight assistant reply.
 *
 * Shows "Responding…" the moment routing begins — before any token exists — so
 * the pause between sending and the first token reads as work rather than a
 * hang. Grounding is announced as soon as retrieval finishes, which is why the
 * provenance note can appear ahead of the text.
 */
export function RespondingBubble({
  text,
  provenance,
  activity,
  installedSkills,
  screens = [],
  onOpenScreen,
}: RespondingBubbleProps) {
  return (
    <div className="min-w-0">
      <div
        className="max-w-[560px] rounded-[18px] bg-bubble px-4 py-2.5 text-[15px] leading-relaxed break-words text-ink-900"
        aria-live="polite"
      >
        {text ? (
          <>
            <MessageMarkdown text={text} />
            <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-ink-500" aria-hidden />
          </>
        ) : (
          <span className="flex items-center gap-2 text-ink-500">
            Responding
            <span className="flex gap-1">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-400 [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-400 [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-400" />
            </span>
          </span>
        )}
      </div>
      <ToolActivity activity={activity} installedSkills={installedSkills} />
      {provenance && <ProvenanceNote provenance={provenance} />}
      {screens.length > 0 && <ScreenStrip screens={screens} onOpen={onOpenScreen ?? (() => {})} />}
    </div>
  )
}
