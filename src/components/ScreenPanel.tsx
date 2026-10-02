'use client'

import Image from 'next/image'
import { useEffect, useMemo, useState } from 'react'
import type { Annotation } from '@/lib/browser/agent-browser'
import type { Screen, ScreenFrame } from '@/lib/domain/screen'
import type { ChannelSummary } from '@/lib/domain/types'
import { useViewer } from './ViewerContext'

interface ScreenPanelProps {
  channel: ChannelSummary
  /** All persisted frames for this channel, newest turn first, steps ascending within a turn. */
  screens: Screen[]
  /** Frames captured so far in the turn currently in flight, oldest first. */
  liveScreens: ScreenFrame[]
  activeScreenId: number | null
  onSelect: (screenId: number) => void
  /** PATCHes the assistant's browser config; the caller shows the rejection inline. */
  onToggleHeaded: (headed: boolean) => Promise<void>
}

/** Either a persisted frame or one still streaming in; only their shared fields are read here. */
type FrameLike = Screen | ScreenFrame

/** Only a persisted `Screen` carries the full annotation list; a live `ScreenFrame` only has a count. */
function hasFullAnnotations(frame: FrameLike): frame is Screen {
  return 'annotations' in frame
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function urlLabel(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    return `${parsed.hostname}${path}`
  } catch {
    return url
  }
}

/** The most recently captured stored frame, by actual capture time rather than list order. */
function newestByTime(frames: Screen[]): Screen | null {
  return frames.reduce<Screen | null>(
    (newest, frame) => (!newest || frame.createdAt > newest.createdAt ? frame : newest),
    null,
  )
}

function Lightbox({ frame, botName, onClose }: { frame: FrameLike; botName: string; onClose: () => void }) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      // Captured ahead of, and stopped from reaching, the bot panel's own
      // Escape handler — otherwise one Escape press would close the lightbox
      // and the panel behind it in the same keystroke.
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  const annotations: Annotation[] = hasFullAnnotations(frame) ? frame.annotations : []

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto overscroll-contain">
      <button
        type="button"
        aria-label="Close screenshot"
        onClick={onClose}
        className="fixed inset-0 cursor-zoom-out bg-ink-900/75"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${botName}'s screen, step ${frame.step}`}
        className="relative z-10 flex min-h-full items-center justify-center p-6"
      >
        <div className="flex max-h-full flex-col gap-3">
          <div className="relative h-[70vh] w-[min(85vw,900px)]">
            {frame.imageUrl ? (
              <Image
                src={frame.imageUrl}
                alt={`${botName}'s screen at step ${frame.step}: ${frame.action}`}
                fill
                sizes="85vw"
                className="object-contain"
                unoptimized
              />
            ) : (
              <p className="flex h-full items-center justify-center text-[13px] text-white/80">
                No image captured for this step.
              </p>
            )}
          </div>
          {annotations.length > 0 && (
            <ul className="max-h-[22vh] w-full overflow-y-auto rounded-xl bg-white p-3 text-[12px] text-ink-700">
              {annotations.map((annotation) => (
                <li key={annotation.number} className="py-0.5">
                  {`#${annotation.number} ${annotation.role} "${annotation.name}"`}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The bot's browser: the latest (or selected) frame large, a headed/headless
 * toggle for its live session, and every step it has taken so far.
 */
export function ScreenPanel({ channel, screens, liveScreens, activeScreenId, onSelect, onToggleHeaded }: ScreenPanelProps) {
  const { role } = useViewer()
  const botName = channel.assistant?.name ?? channel.name
  const [isToggling, setIsToggling] = useState(false)
  const [toggleError, setToggleError] = useState<string | null>(null)
  const [lightboxOpen, setLightboxOpen] = useState(false)

  // A frame is persisted the moment it's captured, so a stored `Screen`
  // for the turn currently in flight can already share a `screenId` with a
  // `liveScreens` entry — e.g. after switching away from this channel mid-turn
  // and back, which re-fetches `screens` while `liveScreens` is still live.
  // Live wins; the stored duplicate is dropped everywhere a frame is chosen
  // or listed, so no `screenId` ever appears twice.
  const liveIds = useMemo(() => new Set(liveScreens.map((s) => s.screenId)), [liveScreens])
  const storedScreens = useMemo(
    () => screens.filter((s) => !liveIds.has(s.screenId)),
    [screens, liveIds],
  )

  const rows = useMemo(
    () => [
      ...liveScreens.map((frame) => ({ ...frame, live: true as const })),
      ...storedScreens.map((frame) => ({ ...frame, live: false as const })),
    ],
    [liveScreens, storedScreens],
  )

  // The active screen: the selected one if it still exists, else the newest
  // live frame (a turn in flight), else the newest frame on record.
  const active: FrameLike | null = useMemo(() => {
    if (activeScreenId != null) {
      const found =
        liveScreens.find((s) => s.screenId === activeScreenId) ??
        storedScreens.find((s) => s.screenId === activeScreenId)
      if (found) return found
    }
    if (liveScreens.length > 0) return liveScreens[liveScreens.length - 1]!
    return newestByTime(storedScreens)
  }, [activeScreenId, liveScreens, storedScreens])

  async function handleToggle() {
    if (!channel.assistant || isToggling) return
    setIsToggling(true)
    setToggleError(null)
    try {
      await onToggleHeaded(!channel.assistant.browser.headed)
    } catch (cause) {
      setToggleError(cause instanceof Error ? cause.message : 'Could not toggle the browser window')
    } finally {
      setIsToggling(false)
    }
  }

  return (
    <div className="flex flex-col">
      <section>
        <p className="mb-1.5 text-[13px] font-semibold text-ink-900">{`${botName}'s screen`}</p>
        <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-line bg-surface">
          {active?.imageUrl ? (
            <button
              type="button"
              onClick={() => setLightboxOpen(true)}
              aria-label={`Open ${botName}'s screen at step ${active.step}, full size`}
              className="absolute inset-0 cursor-zoom-in"
            >
              <Image
                src={active.imageUrl}
                alt={`${botName}'s screen at step ${active.step}: ${active.action}`}
                fill
                sizes="(max-width: 768px) 100vw, 340px"
                className="object-contain"
                unoptimized
              />
            </button>
          ) : (
            <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-ink-500">
              {active ? 'No image captured for this step.' : 'No screen yet. Ask the bot to open a web page.'}
            </div>
          )}
        </div>
        {active && (
          <div className="mt-1.5 flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-500" title={active.url}>
              {urlLabel(active.url)}
            </p>
            {active.flagged && (
              <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                Possibly irreversible
              </span>
            )}
          </div>
        )}
      </section>

      {/* The window opens on the server's screen, so only admins get the switch. */}
      {channel.assistant && role === 'admin' && (
        <section className="mt-4 border-t border-line pt-3">
          <button
            type="button"
            onClick={() => void handleToggle()}
            disabled={isToggling}
            className="cursor-pointer rounded-xl bg-surface px-3 py-1.5 text-[13px] font-semibold text-ink-900 transition-colors hover:bg-line disabled:cursor-not-allowed disabled:opacity-50"
          >
            {channel.assistant.browser.headed ? 'Hide window' : 'Show window'}
          </button>
          <p className="mt-1.5 text-[11px] leading-snug text-ink-500">
            {"Opens the bot's browser as a visible window on this Mac. Close it or toggle back to return control."}
          </p>
          {toggleError && (
            <p role="alert" className="mt-1 text-[11px] text-rose-700">
              {toggleError}
            </p>
          )}
        </section>
      )}

      <section className="mt-4 border-t border-line pt-3">
        <h3 className="mb-2 text-[11px] font-bold tracking-wide text-ink-500 uppercase">Steps</h3>
        {rows.length === 0 ? (
          <p className="text-[12px] text-ink-500">No steps yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {rows.map((row) => {
              const isActive = row.screenId === active?.screenId
              return (
                <li key={row.screenId}>
                  <button
                    type="button"
                    onClick={() => onSelect(row.screenId)}
                    aria-current={isActive ? 'true' : undefined}
                    className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
                      isActive ? 'bg-surface ring-1 ring-line' : 'hover:bg-surface'
                    }`}
                  >
                    <span className="relative h-10 w-16 shrink-0 overflow-hidden rounded-md bg-white ring-1 ring-line">
                      {row.imageUrl && (
                        <Image
                          src={row.imageUrl}
                          alt={`Step ${row.step}: ${row.action}`}
                          fill
                          sizes="64px"
                          className="object-cover object-top"
                          unoptimized
                        />
                      )}
                      {row.live && (
                        <span
                          aria-hidden="true"
                          className="absolute top-0.5 right-0.5 h-2 w-2 animate-pulse rounded-full bg-brand-500"
                        />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate font-mono text-[12px] text-ink-900">
                          {row.step}. {row.action}
                          {row.target ? ` ${row.target}` : ''}
                        </span>
                        {row.flagged && (
                          <span className="shrink-0 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                            irreversible?
                          </span>
                        )}
                      </span>
                      {row.intent && <span className="block truncate text-[11px] text-ink-700">{row.intent}</span>}
                      <span className="block truncate text-[10px] text-ink-500">{hostnameOf(row.url)}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {lightboxOpen && active && (
        <Lightbox frame={active} botName={botName} onClose={() => setLightboxOpen(false)} />
      )}
    </div>
  )
}
