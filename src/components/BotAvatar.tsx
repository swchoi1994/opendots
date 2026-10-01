import type { AvatarShape, BotAvatar as BotAvatarModel } from '@/lib/domain/avatar'

/*
 * Flat organic shapes in a 40x40 box. Each path is closed and centred so the
 * two white "eye" marks land in the same place regardless of shape.
 */
const PATHS: Record<AvatarShape, string> = {
  blob: 'M20 3c8 0 17 6 17 16s-7 18-17 18S3 30 3 20 12 3 20 3z',
  drop: 'M20 3c6 8 15 15 15 23a15 15 0 0 1-30 0C5 18 14 11 20 3z',
  cloud: 'M12 33a8 8 0 0 1-1-16 10 10 0 0 1 19-2 7 7 0 0 1 3 18z',
  twin: 'M14 8a11 11 0 1 1 5 20.7A11 11 0 1 1 14 8zm12 4a10 10 0 1 1 0 20 10 10 0 0 1 0-20z',
  pebble: 'M21 4c9 0 16 6 16 15s-5 17-16 17S4 30 4 19 12 4 21 4z',
  egg: 'M20 3c7 0 14 10 14 20s-6 14-14 14S6 33 6 23 13 3 20 3z',
  pill: 'M14 10h12a10 10 0 0 1 0 20H14a10 10 0 0 1 0-20z',
  triangle: 'M18 5a3 3 0 0 1 4 0l14 24a3 3 0 0 1-2 5H6a3 3 0 0 1-2-5z',
  tile: 'M11 4h18a7 7 0 0 1 7 7v18a7 7 0 0 1-7 7H11a7 7 0 0 1-7-7V11a7 7 0 0 1 7-7z',
}

export function BotAvatar({ avatar, size = 44 }: { avatar: BotAvatarModel; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      aria-hidden="true"
      className="shrink-0"
      style={{ color: `var(--color-av-${avatar.color})` }}
    >
      <path d={PATHS[avatar.shape]} fill="currentColor" />
      <path d="M15 19l2 4M23 19l2 4" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" opacity="0.9" />
    </svg>
  )
}
