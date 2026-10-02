import type { ChannelSummary, User } from '@/lib/domain/types'
import { initials } from '@/lib/format'

/*
 * Literal class strings, not `bg-av-${token}`. Tailwind scans source text for
 * complete class names, so an interpolated name is never emitted into the CSS.
 */
const AVATAR_BG: Record<string, string> = {
  teal: 'bg-av-teal',
  violet: 'bg-av-violet',
  amber: 'bg-av-amber',
  emerald: 'bg-av-emerald',
  rose: 'bg-av-rose',
  sky: 'bg-av-sky',
  blue: 'bg-av-blue',
  green: 'bg-av-green',
  brown: 'bg-av-brown',
  orange: 'bg-av-orange',
  red: 'bg-av-red',
  pink: 'bg-av-pink',
  indigo: 'bg-av-indigo',
}

function backgroundFor(user: User): string {
  return AVATAR_BG[user.colorToken] ?? 'bg-av-sky'
}

export function Avatar({ user, size = 40 }: { user: User; size?: number }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${backgroundFor(user)}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {initials(user.nickname)}
    </span>
  )
}

/**
 * Who the channel is *with*: its bot. Whoever is looking is the other member,
 * and that is a different person per viewer, so the bot is picked out by its
 * id rather than by excluding "me".
 */
export function counterparts(channel: ChannelSummary): User[] {
  const bots = channel.members.filter((member) => member.userId.startsWith('bot_'))
  return bots.length > 0 ? bots : channel.members
}

/**
 * One avatar for a 1:1 channel, a 2x2 tile for a group — the same treatment the
 * original client used to make group channels scannable in the list.
 */
export function ChannelAvatar({ channel, size = 48 }: { channel: ChannelSummary; size?: number }) {
  const others = counterparts(channel)
  const first = others[0]

  if (!first) {
    return <span className="inline-block rounded-full bg-line" style={{ width: size, height: size }} />
  }

  if (others.length === 1) {
    return <Avatar user={first} size={size} />
  }

  const tiles = others.slice(0, 4)
  return (
    <span
      className="grid shrink-0 grid-cols-2 grid-rows-2 overflow-hidden rounded-full"
      style={{ width: size, height: size }}
    >
      {tiles.map((member) => (
        <span
          key={member.userId}
          className={`flex items-center justify-center font-semibold text-white ${backgroundFor(member)}`}
          style={{ fontSize: Math.round(size * 0.2) }}
        >
          {initials(member.nickname)}
        </span>
      ))}
    </span>
  )
}
