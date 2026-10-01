'use client'
import Image from 'next/image'
import type { Screen } from '@/lib/domain/screen'

/** Shape shared by a persisted `Screen` and a live `ScreenFrame`, all the strip needs. */
export type ScreenStripFrame = Pick<
  Screen,
  'screenId' | 'step' | 'action' | 'target' | 'intent' | 'imageUrl' | 'flagged'
>

/** Up to five thumbnails under a bot reply; click opens the Screen tab at that step. */
export function ScreenStrip({ screens, onOpen }: { screens: ScreenStripFrame[]; onOpen: (screenId: number) => void }) {
  if (screens.length === 0) return null
  const shown = screens.slice(0, 5)
  const more = screens.length - shown.length
  return (
    <div className="mt-1.5 flex items-center gap-1.5">
      {shown.map((s) => (
        <button key={s.screenId} type="button" onClick={() => onOpen(s.screenId)} title={`${s.step}. ${s.action}${s.target ? ` ${s.target}` : ''} — ${s.intent ?? ''}`}
          className="relative h-12 w-20 shrink-0 cursor-pointer overflow-hidden rounded-md bg-surface ring-1 ring-line hover:ring-ink-400">
          {s.imageUrl ? <Image src={s.imageUrl} alt={`Step ${s.step}: ${s.action}`} fill sizes="80px" className="object-cover object-top" unoptimized /> : <span className="flex h-full items-center justify-center text-[10px] text-ink-500">{s.action}</span>}
          {s.flagged && <span aria-label="Potentially irreversible" className="absolute top-0.5 right-0.5 h-2 w-2 rounded-full bg-amber-500" />}
        </button>
      ))}
      {more > 0 && <span className="text-[11px] text-ink-500">+{more}</span>}
    </div>
  )
}
