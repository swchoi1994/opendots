import { BotAvatar } from './BotAvatar'
import { DeployButton } from './DeployButton'
import { FrozenIcon, ScreenIcon, SearchIcon, SettingsIcon } from './icons'
import { avatarFromName } from '@/lib/domain/avatar'
import type { ChannelSummary } from '@/lib/domain/types'

interface ChannelHeaderProps {
  channel: ChannelSummary
  isSearchOpen: boolean
  isInfoOpen: boolean
  onToggleSearch: () => void
  onToggleInfo: () => void
  onToggleScreen: () => void
  /** True while the bot's current turn has captured at least one live frame. */
  hasLiveScreens?: boolean
}

export function ChannelHeader({
  channel,
  isSearchOpen,
  isInfoOpen,
  onToggleSearch,
  onToggleInfo,
  onToggleScreen,
  hasLiveScreens = false,
}: ChannelHeaderProps) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
      <BotAvatar avatar={channel.assistant?.avatar ?? avatarFromName(channel.name)} size={28} />
      <h2 className="truncate text-[16px] font-semibold text-ink-900">{channel.name}</h2>
      {channel.isFrozen && (
        <span className="flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[11px] font-semibold text-ink-700">
          <FrozenIcon className="h-3 w-3" /> Frozen
        </span>
      )}
      <div className="ml-auto flex items-center gap-1 text-ink-700">
        <button type="button" onClick={onToggleScreen} title="Show bot's screen" aria-label="Show bot's screen" className="relative cursor-pointer rounded-full p-1.5 transition-colors hover:bg-surface">
          <ScreenIcon className="h-5 w-5" />
          {hasLiveScreens && (
            <span
              aria-hidden="true"
              className="absolute top-0.5 right-0.5 h-2 w-2 animate-pulse rounded-full bg-brand-500"
            />
          )}
        </button>
        <DeployButton channelUrl={channel.channelUrl} />
        <button type="button" onClick={onToggleSearch} aria-label="Search in conversation" aria-pressed={isSearchOpen} className={`cursor-pointer rounded-full p-1.5 transition-colors hover:bg-surface ${isSearchOpen ? 'bg-surface' : ''}`}>
          <SearchIcon className="h-5 w-5" />
        </button>
        <button type="button" onClick={onToggleInfo} aria-label="Bot settings" aria-pressed={isInfoOpen} className={`cursor-pointer rounded-full p-1.5 transition-colors hover:bg-surface ${isInfoOpen ? 'bg-surface' : ''}`}>
          <SettingsIcon className="h-5 w-5" />
        </button>
      </div>
    </header>
  )
}
