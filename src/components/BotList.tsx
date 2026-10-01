'use client'

import { useState } from 'react'
import { Avatar } from './Avatar'
import { BotListItem } from './BotListItem'
import { PlugIcon, PlusIcon, SearchIcon } from './icons'
import { me } from '@/lib/domain/seed'
import type { ChannelSummary } from '@/lib/domain/types'

interface BotListProps {
  channels: ChannelSummary[]
  selectedUrl: string | null
  isLoading: boolean
  onSelect: (channelUrl: string) => void
  onNewBot: () => void
  onDelete: (channelUrl: string) => void
}

export function BotList({ channels, selectedUrl, isLoading, onSelect, onNewBot, onDelete }: BotListProps) {
  const [confirmingUrl, setConfirmingUrl] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const visible = filter.trim()
    ? channels.filter((c) => c.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : channels

  return (
    <aside className="flex w-[320px] shrink-0 flex-col border-r border-line bg-white">
      <header className="flex h-14 shrink-0 items-center justify-between px-4">
        <h1 className="text-[17px] font-bold text-ink-900">OpenDots</h1>
        <button type="button" onClick={onNewBot} aria-label="New bot" className="cursor-pointer rounded-full p-1.5 text-ink-700 transition-colors hover:bg-surface">
          <PlusIcon className="h-5 w-5" />
        </button>
      </header>

      <div className="px-3 pb-2">
        <label className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2 text-ink-500">
          <SearchIcon className="h-4 w-4" />
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search"
            aria-label="Search bots"
            className="min-w-0 flex-1 bg-transparent text-[14px] text-ink-900 outline-none placeholder:text-ink-400"
          />
        </label>
      </div>

      {isLoading ? (
        <p className="px-4 py-6 text-[13px] text-ink-500">Loading bots…</p>
      ) : visible.length === 0 ? (
        <p className="px-4 py-6 text-[13px] text-ink-500">
          {channels.length === 0 ? 'No bots yet. Use + to create one.' : 'No bots match.'}
        </p>
      ) : (
        <ul className="thread-scroll flex-1 overflow-y-auto pb-2">
          {visible.map((channel) => (
            <BotListItem
              key={channel.channelUrl}
              channel={channel}
              isSelected={channel.channelUrl === selectedUrl}
              isConfirmingDelete={confirmingUrl === channel.channelUrl}
              onSelect={onSelect}
              onRequestDelete={setConfirmingUrl}
              onCancelDelete={() => setConfirmingUrl(null)}
              onConfirmDelete={(url) => {
                setConfirmingUrl(null)
                onDelete(url)
              }}
            />
          ))}
        </ul>
      )}

      <footer className="mt-auto shrink-0 border-t border-line px-3 py-2">
        <button
          type="button"
          disabled
          title="Plugins arrive in Phase 4"
          className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-[14px] text-ink-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <PlugIcon className="h-5 w-5" />
          Plugins
        </button>
        <div className="flex items-center gap-3 px-2.5 py-2 text-[14px] text-ink-900">
          <Avatar user={me} size={28} />
          {me.nickname}
        </div>
      </footer>
    </aside>
  )
}
