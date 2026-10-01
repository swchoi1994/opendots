import { BotAvatar } from './BotAvatar'
import { CheckIcon, CloseIcon, TrashIcon } from './icons'
import { avatarFromName } from '@/lib/domain/avatar'
import type { ChannelSummary } from '@/lib/domain/types'
import { isUserMessage } from '@/lib/domain/types'
import { formatChannelTimestamp, previewText } from '@/lib/format'

function preview(channel: ChannelSummary): string {
  const last = channel.lastMessage
  if (!last) return 'No messages yet'
  return isUserMessage(last) ? previewText(last.message) : `📎 ${last.name}`
}

interface BotListItemProps {
  channel: ChannelSummary
  isSelected: boolean
  isConfirmingDelete: boolean
  onSelect: (channelUrl: string) => void
  onRequestDelete: (channelUrl: string) => void
  onCancelDelete: () => void
  onConfirmDelete: (channelUrl: string) => void
}

export function BotListItem({
  channel, isSelected, isConfirmingDelete, onSelect, onRequestDelete, onCancelDelete, onConfirmDelete,
}: BotListItemProps) {
  const avatar = channel.assistant?.avatar ?? avatarFromName(channel.name)
  const timestamp = formatChannelTimestamp(channel.lastMessage?.createdAt ?? channel.createdAt)
  const label = [channel.name, channel.unreadMessageCount > 0 ? `${channel.unreadMessageCount} unread` : null]
    .filter(Boolean)
    .join(', ')

  return (
    <li className="group relative px-2">
      <button
        type="button"
        onClick={() => onSelect(channel.channelUrl)}
        aria-current={isSelected ? 'true' : undefined}
        aria-label={label}
        className={`flex w-full cursor-pointer items-center gap-3 rounded-2xl py-2.5 pr-10 pl-2.5 text-left transition-colors ${
          isSelected ? 'bg-surface' : 'hover:bg-surface/70'
        }`}
      >
        <BotAvatar avatar={avatar} size={44} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-[15px] font-semibold text-ink-900">{channel.name}</span>
            <span className="ml-auto shrink-0 text-[12px] text-ink-500">{timestamp}</span>
          </span>
          <span className="mt-0.5 flex items-center gap-2">
            <span className="line-clamp-1 flex-1 text-[13px] text-ink-500">{preview(channel)}</span>
            {channel.unreadMessageCount > 0 && (
              <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-brand-500" />
            )}
          </span>
        </span>
      </button>

      {isConfirmingDelete ? (
        <span className="absolute top-1/2 right-3 flex -translate-y-1/2 items-center gap-1 rounded-full bg-white p-0.5 shadow-sm ring-1 ring-line">
          <button type="button" onClick={() => onConfirmDelete(channel.channelUrl)} aria-label={`Confirm delete ${channel.name}`} className="cursor-pointer rounded-full bg-rose-600 p-1 text-white hover:bg-rose-700">
            <CheckIcon className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={onCancelDelete} aria-label="Cancel delete" className="cursor-pointer rounded-full p-1 text-ink-500 hover:bg-line">
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => onRequestDelete(channel.channelUrl)}
          aria-label={`Delete ${channel.name}`}
          className="absolute top-1/2 right-3 -translate-y-1/2 cursor-pointer rounded-full p-1.5 text-ink-400 opacity-0 transition-all group-hover:opacity-100 hover:bg-rose-50 hover:text-rose-600 focus-visible:opacity-100"
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      )}
    </li>
  )
}
