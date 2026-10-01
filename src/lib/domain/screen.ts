import type { Annotation } from '../browser/agent-browser'

/** One frame of a bot's screen: what it saw right after one browser action. */
export interface Screen {
  screenId: number
  channelUrl: string
  turnId: string
  /** The bot reply this frame belongs to; null while the turn is in flight. */
  messageId: number | null
  step: number
  action: string
  target: string | null
  intent: string | null
  url: string
  title: string
  imageUrl: string | null
  annotations: Annotation[]
  flagged: boolean
  createdAt: number
}

export interface NewScreen extends Omit<Screen, 'screenId' | 'imageUrl' | 'createdAt' | 'messageId'> {
  imagePath: string | null
}

export function screenImageUrl(channelUrl: string, screenId: number): string {
  return `/api/channels/${encodeURIComponent(channelUrl)}/screens/${screenId}`
}

/**
 * The one ordering rule for `listScreens`, shared by every store.
 *
 * Turns interleave — a bot can start a second turn before the first one's
 * screens finish landing — so "oldest first within a turn, turns newest
 * first" is ambiguous unless every backend derives turn order the same way.
 * This sorts by `createdAt` then `step` to find when each turn started, then
 * orders turns by that start time, newest first; within a turn, steps
 * ascend.
 */
export function groupScreensByTurn(screens: Screen[]): Screen[] {
  const sorted = [...screens].sort((a, b) => a.createdAt - b.createdAt || a.step - b.step)
  // First appearance in the ascending scan is when a turn started; reverse
  // so the newest-starting turn comes first.
  const turnOrder = [...new Set(sorted.map((s) => s.turnId))].reverse()
  return turnOrder.flatMap((turnId) =>
    sorted.filter((s) => s.turnId === turnId).sort((a, b) => a.step - b.step),
  )
}

/** Rewrites a channel-scoped screen image URL for a deployment share link. */
export function deploymentImageUrl(deploymentId: string, screenId: number): string {
  return `/api/deployments/${encodeURIComponent(deploymentId)}/screens/${screenId}`
}

/** The SSE payload for a `screen` frame: a `Screen` minus its persistence fields. */
export type ScreenFrame = Pick<
  Screen,
  'screenId' | 'step' | 'action' | 'target' | 'intent' | 'url' | 'title' | 'imageUrl' | 'flagged'
> & { annotationCount: number }

export function screenFrame(s: Screen): ScreenFrame {
  const { screenId, step, action, target, intent, url, title, imageUrl, flagged } = s
  return { screenId, step, action, target, intent, url, title, imageUrl, flagged, annotationCount: s.annotations.length }
}
