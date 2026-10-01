/**
 * Bot avatars are a flat SVG shape in a solid colour (the reference UI uses
 * blobs, drops, clouds, and tiles). Kept as two small catalogs so config stays
 * data and the renderer (BotAvatar.tsx) owns the paths.
 */

export const AVATAR_SHAPES = [
  'blob', 'drop', 'cloud', 'twin', 'pebble', 'egg', 'pill', 'triangle', 'tile',
] as const
export const AVATAR_COLORS = [
  'violet', 'blue', 'green', 'teal', 'brown', 'orange', 'red', 'pink', 'indigo',
] as const

export type AvatarShape = (typeof AVATAR_SHAPES)[number]
export type AvatarColor = (typeof AVATAR_COLORS)[number]

export interface BotAvatar {
  shape: AvatarShape
  color: AvatarColor
}

export function isAvatarShape(value: unknown): value is AvatarShape {
  return typeof value === 'string' && (AVATAR_SHAPES as readonly string[]).includes(value)
}

export function isAvatarColor(value: unknown): value is AvatarColor {
  return typeof value === 'string' && (AVATAR_COLORS as readonly string[]).includes(value)
}

function hash(text: string): number {
  // FNV-1a, 32-bit. Deterministic across processes, unlike Math.random.
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

export function avatarFromName(name: string): BotAvatar {
  const h = hash(name.trim().toLowerCase())
  return {
    shape: AVATAR_SHAPES[h % AVATAR_SHAPES.length]!,
    color: AVATAR_COLORS[Math.floor(h / AVATAR_SHAPES.length) % AVATAR_COLORS.length]!,
  }
}

export function parseAvatar(input: unknown, fallbackName: string): BotAvatar {
  const fallback = avatarFromName(fallbackName)
  const raw = (input ?? {}) as Partial<BotAvatar>
  return {
    shape: isAvatarShape(raw.shape) ? raw.shape : fallback.shape,
    color: isAvatarColor(raw.color) ? raw.color : fallback.color,
  }
}
