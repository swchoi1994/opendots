'use client'

import { useState } from 'react'
import { BotList } from './BotList'
import { BotPanel, type PanelTab } from './BotPanel'
import { ChannelHeader } from './ChannelHeader'
import { MessageInput } from './MessageInput'
import { MessageThread } from './MessageThread'
import { NewBotDialog } from './NewBotDialog'
import { ThreadSearch } from './ThreadSearch'
import { ViewerProvider, type ClientViewer } from './ViewerContext'
import { useChat } from '@/hooks/useChat'
import type { ChannelSummary } from '@/lib/domain/types'

export function ChatShell({ viewer }: { viewer: ClientViewer }) {
  const {
    channels,
    selectedChannel,
    selectedUrl,
    selectChannel,
    createChannel,
    deleteChannel,
    applyChannelUpdate,
    messages,
    isBootstrapping,
    isLoadingMessages,
    isSending,
    responding,
    error,
    sendMessage,
    screens,
    activeScreenId,
    openScreen,
    hasLiveScreens,
  } = useChat()
  const liveScreens = responding?.screens ?? []

  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [isInfoOpen, setIsInfoOpen] = useState(false)
  const [panelTab, setPanelTab] = useState<PanelTab>('settings')
  const [highlightMessageId, setHighlightMessageId] = useState<number | null>(null)
  const [lastChannelUrl, setLastChannelUrl] = useState(selectedUrl)

  /*
   * Adjusting state during render, React's documented pattern for "reset when a
   * prop changes". Doing it in an effect would render once with the previous
   * conversation's search still open, then again to clear it — and the stale
   * frame is exactly what the user would see.
   */
  if (lastChannelUrl !== selectedUrl) {
    setLastChannelUrl(selectedUrl)
    setIsSearchOpen(false)
    setHighlightMessageId(null)
    openScreen(null)
  }

  const isFrozen = selectedChannel?.isFrozen ?? false

  /** Opening a thumbnail also opens the panel on the Screen tab. */
  const handleOpenScreen = (screenId: number) => {
    openScreen(screenId)
    setPanelTab('screen')
    setIsInfoOpen(true)
  }

  /** Switches the bot's browser between headless and a visible window. */
  const handleToggleHeaded = async (headed: boolean) => {
    if (!selectedChannel) return
    const response = await fetch(`/api/channels/${selectedChannel.channelUrl}/browser`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headed }),
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error ?? 'Could not toggle the browser window')
    }
    const { channel } = (await response.json()) as { channel: ChannelSummary }
    applyChannelUpdate(channel)
  }

  return (
    <ViewerProvider value={viewer}>
      <main className="flex h-screen w-full overflow-hidden bg-white">
        <BotList
          channels={channels}
          selectedUrl={selectedUrl}
          isLoading={isBootstrapping}
          onSelect={selectChannel}
          onNewBot={() => setIsDialogOpen(true)}
          onDelete={deleteChannel}
        />

        <section className="flex min-w-0 flex-1 flex-col">
          {selectedChannel ? (
            <>
              <ChannelHeader
                channel={selectedChannel}
                isSearchOpen={isSearchOpen}
                isInfoOpen={isInfoOpen}
                onToggleSearch={() => setIsSearchOpen((open) => !open)}
                onToggleInfo={() => {
                  setPanelTab('settings')
                  setIsInfoOpen((open) => !open)
                }}
                onToggleScreen={() => {
                  setPanelTab('screen')
                  setIsInfoOpen(true)
                }}
                hasLiveScreens={hasLiveScreens}
              />

              {isSearchOpen && (
                <ThreadSearch
                  messages={messages}
                  onClose={() => {
                    setIsSearchOpen(false)
                    setHighlightMessageId(null)
                  }}
                  onJumpTo={setHighlightMessageId}
                />
              )}

              {error && (
                <p
                  role="alert"
                  className="border-b border-line bg-rose-50 px-6 py-2 text-[13px] text-rose-700"
                >
                  {error}
                </p>
              )}

              <MessageThread
                messages={messages}
                isLoading={isLoadingMessages}
                responding={responding}
                highlightMessageId={highlightMessageId}
                screens={screens}
                onOpenScreen={handleOpenScreen}
              />

              <MessageInput
                disabled={isFrozen}
                isSending={isSending}
                botName={selectedChannel.assistant?.name ?? selectedChannel.name}
                onSend={async (text) => {
                  // Sending returns attention to the live end of the thread.
                  setHighlightMessageId(null)
                  await sendMessage(text)
                }}
                placeholder={isFrozen ? 'This channel is frozen' : undefined}
              />
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3">
              <p className="text-[13px] text-ink-500">
                {isBootstrapping ? 'Loading…' : 'Pick a bot, or create one with +'}
              </p>
              {!isBootstrapping && (
                <button
                  type="button"
                  onClick={() => setIsDialogOpen(true)}
                  className="cursor-pointer rounded-lg bg-brand-500 px-4 py-2 text-[14px] font-semibold text-white transition-colors hover:bg-brand-600"
                >
                  New bot
                </button>
              )}
            </div>
          )}
        </section>

        {selectedChannel && isInfoOpen && (
          <BotPanel
            // Remount per conversation so the edit form never shows another's values.
            key={selectedChannel.channelUrl}
            channel={selectedChannel}
            onClose={() => setIsInfoOpen(false)}
            onSaved={applyChannelUpdate}
            onDelete={(url) => {
              setIsInfoOpen(false)
              deleteChannel(url)
            }}
            panelTab={panelTab}
            onTabChange={setPanelTab}
            screens={screens}
            liveScreens={liveScreens}
            activeScreenId={activeScreenId}
            onSelectScreen={openScreen}
            onToggleHeaded={handleToggleHeaded}
          />
        )}

        <NewBotDialog
          open={isDialogOpen}
          onClose={() => setIsDialogOpen(false)}
          onCreate={createChannel}
        />
      </main>
    </ViewerProvider>
  )
}
