const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

function startOfDay(value: number): number {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** "9:35 AM" */
export function formatTime(epochMs: number): string {
  return TIME.format(epochMs)
}

/** Time for today, "Yesterday" for yesterday, "Aug 2" beyond that. */
export function formatChannelTimestamp(epochMs: number, now = Date.now()): string {
  const today = startOfDay(now)
  const dayMs = 24 * 60 * 60 * 1000

  if (epochMs >= today) return TIME.format(epochMs)
  if (epochMs >= today - dayMs) return 'Yesterday'
  return MONTH_DAY.format(epochMs)
}

/** The unread badge saturates at 99+ rather than growing without bound. */
export function formatUnreadCount(count: number): string {
  return count > 99 ? '99+' : String(count)
}

export function initials(nickname: string): string {
  const parts = nickname.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase()
  return (parts[0]!.slice(0, 1) + parts[1]!.slice(0, 1)).toUpperCase()
}

/**
 * Collapse a Markdown message into one line of prose for the channel list.
 * Headings, emphasis, list markers, inline code and link syntax are removed
 * and whitespace is folded, so the sidebar shows what the bot said rather than
 * how it was marked up.
 */
export function previewText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_](?=\S)(.*?)(?<=\S)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}
