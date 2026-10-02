'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AssistantConfig } from '@/lib/domain/assistant'
import type { Screen, ScreenFrame } from '@/lib/domain/screen'
import type { ChannelSummary, MessageProvenance, MessageWithReceipt } from '@/lib/domain/types'
import { readError } from '@/lib/client-errors'

export interface ToolActivityState {
  /** SDK tool name, e.g. `mcp__opendots__search_knowledge` or `Read`. */
  name: string
  summary: string
  done: boolean
  ok: boolean
}

export interface RespondingState {
  channelUrl: string
  text: string
  provenance: MessageProvenance | null
  /** The most recent tool call, so the bubble can show what the bot is doing. */
  activity: ToolActivityState | null
  installedSkills: string[]
  /** Browser frames captured so far this turn, in the order they arrived. */
  screens: ScreenFrame[]
}

/**
 * Reads an SSE body, invoking `onEvent` per complete frame.
 *
 * Written by hand rather than with EventSource because EventSource cannot issue
 * a POST. Frames are separated by a blank line, and a single network read can
 * split one anywhere, so the tail is buffered until its terminator arrives.
 */
async function consumeEventStream(
  response: Response,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) return

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''

    for (const raw of frames) {
      let event = 'message'
      const dataLines: string[] = []

      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      }

      if (dataLines.length === 0) continue
      try {
        onEvent(event, JSON.parse(dataLines.join('\n')))
      } catch {
        // Ignore a malformed frame rather than aborting the whole stream.
      }
    }
  }
}

interface Thread {
  channelUrl: string
  messages: MessageWithReceipt[]
}


export function useChat() {
  const [channels, setChannels] = useState<ChannelSummary[]>([])
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null)
  const [thread, setThread] = useState<Thread | null>(null)
  const [isBootstrapping, setIsBootstrapping] = useState(true)
  const [isSending, setIsSending] = useState(false)
  const [responding, setResponding] = useState<RespondingState | null>(null)
  const [error, setError] = useState<string | null>(null)
  /**
   * All persisted frames for a channel, refetched after each `done`. Scoped
   * to the channel it was fetched for (like `thread`), so a `refresh` that
   * resolves after the user has switched channels can't clobber the screens
   * of the channel now on screen.
   */
  const [screenState, setScreenState] = useState<{ channelUrl: string; screens: Screen[] } | null>(
    null,
  )
  const [activeScreenId, setActiveScreenId] = useState<number | null>(null)

  /**
   * The conversation on screen right now, readable from async work that started
   * before the user switched. Kept in a ref rather than a `refresh` dependency
   * so the callback identity stays stable across selection changes.
   */
  const selectedUrlRef = useRef(selectedUrl)
  useEffect(() => {
    selectedUrlRef.current = selectedUrl
  }, [selectedUrl])

  /*
   * Derived, never stored. Writing `setIsLoading(true)` in an effect body
   * renders, commits, then immediately schedules a second render — React
   * Compiler flags it, and the state was never independent anyway: the thread
   * is loading exactly when the selected channel isn't the one we hold.
   */
  const isLoadingMessages = selectedUrl !== null && thread?.channelUrl !== selectedUrl
  const selectedChannel = channels.find((channel) => channel.channelUrl === selectedUrl) ?? null

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const response = await fetch('/api/channels')
        if (!response.ok) throw new Error(await readError(response, 'Could not load channels'))

        const { channels: loaded } = (await response.json()) as { channels: ChannelSummary[] }
        if (cancelled) return

        setChannels(loaded)
        setSelectedUrl((current) => current ?? loaded[0]?.channelUrl ?? null)
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load channels')
      } finally {
        if (!cancelled) setIsBootstrapping(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!selectedUrl) return
    let cancelled = false

    void (async () => {
      try {
        const [response, screensResponse] = await Promise.all([
          fetch(`/api/channels/${selectedUrl}/messages`),
          fetch(`/api/channels/${selectedUrl}/screens`),
        ])
        if (!response.ok) throw new Error(await readError(response, 'Could not load messages'))

        const { messages } = (await response.json()) as { messages: MessageWithReceipt[] }
        if (cancelled) return
        setThread({ channelUrl: selectedUrl, messages })
        if (screensResponse.ok) {
          const { screens: loadedScreens } = (await screensResponse.json()) as { screens: Screen[] }
          if (!cancelled) setScreenState({ channelUrl: selectedUrl, screens: loadedScreens })
        }
        setError(null)

        // Opening a channel clears its unread badge.
        const readResponse = await fetch(`/api/channels/${selectedUrl}/read`, { method: 'POST' })
        if (!readResponse.ok || cancelled) return

        const { channel } = (await readResponse.json()) as { channel: ChannelSummary }
        if (cancelled) return
        setChannels((current) =>
          current.map((existing) =>
            existing.channelUrl === channel.channelUrl ? channel : existing,
          ),
        )
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load messages')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [selectedUrl])

  const refresh = useCallback(async (channelUrl: string) => {
    const [messagesResponse, channelsResponse, screensResponse] = await Promise.all([
      fetch(`/api/channels/${channelUrl}/messages`),
      fetch('/api/channels'),
      fetch(`/api/channels/${channelUrl}/screens`),
    ])

    if (channelsResponse.ok) {
      const { channels: refreshed } = (await channelsResponse.json()) as {
        channels: ChannelSummary[]
      }
      setChannels(refreshed)
    }

    /*
     * The channel list is global, so it is refreshed either way — but the thread
     * and the frames belong to one conversation. A refresh that resolves after
     * the user moved on would otherwise write the old bot's messages and screens
     * into the panes now showing a different bot (which then render empty, since
     * both are compared against `selectedUrl`). This also fixes the Phase 1
     * thread clobber, where a slow `/messages` from the previous conversation
     * landed in the new one.
     */
    if (channelUrl !== selectedUrlRef.current) return

    if (messagesResponse.ok) {
      const { messages } = (await messagesResponse.json()) as { messages: MessageWithReceipt[] }
      setThread({ channelUrl, messages })
    }
    if (screensResponse.ok) {
      const { screens: refreshedScreens } = (await screensResponse.json()) as { screens: Screen[] }
      setScreenState({ channelUrl, screens: refreshedScreens })
    }
  }, [])

  const sendMessage = useCallback(
    async (text: string) => {
      if (!selectedUrl) return
      const trimmed = text.trim()
      if (!trimmed) return

      setIsSending(true)
      try {
        const response = await fetch(`/api/channels/${selectedUrl}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: trimmed }),
        })

        if (!response.ok) {
          setError(await readError(response, 'Could not send message'))
          return
        }

        const { expectsReply } = (await response.json()) as { expectsReply?: boolean }
        await refresh(selectedUrl)
        setError(null)

        if (!expectsReply) return

        // Paint "Responding…" before the request even goes out, so the gap
        // between sending and the first token never reads as a hang.
        setResponding({
          channelUrl: selectedUrl,
          text: '',
          provenance: null,
          activity: null,
          installedSkills: [],
          screens: [],
        })

        const stream = await fetch(`/api/channels/${selectedUrl}/respond`, { method: 'POST' })
        if (!stream.ok) {
          setError(await readError(stream, 'Assistant could not respond'))
          setResponding(null)
          return
        }

        await consumeEventStream(stream, (event, data) => {
          if (event === 'provenance') {
            setResponding((current) =>
              current ? { ...current, provenance: data as MessageProvenance } : current,
            )
          } else if (event === 'token') {
            const { token } = data as { token: string }
            setResponding((current) => (current ? { ...current, text: current.text + token } : current))
          } else if (event === 'tool_start') {
            const { name, summary } = data as { name: string; summary: string }
            setResponding((current) =>
              current ? { ...current, activity: { name, summary, done: false, ok: true } } : current,
            )
          } else if (event === 'tool_result') {
            const { name, ok, summary } = data as { name: string; ok: boolean; summary: string }
            setResponding((current) =>
              current ? { ...current, activity: { name, summary, done: true, ok } } : current,
            )
          } else if (event === 'skill_installed') {
            const { skill } = data as { skill: string }
            setResponding((current) =>
              current ? { ...current, installedSkills: [...current.installedSkills, skill] } : current,
            )
          } else if (event === 'screen') {
            const frame = data as ScreenFrame
            setResponding((current) =>
              current ? { ...current, screens: [...current.screens, frame] } : current,
            )
          } else if (event === 'error') {
            const { error: detail, kind } = data as { error?: string; kind?: string }
            setError(
              kind === 'usage_limit'
                ? 'The model provider reported a rate or usage limit. The bot will answer again once it resets.'
                : (detail ?? 'Bot could not respond'),
            )
          }
        })

        setResponding(null)
        await refresh(selectedUrl)
      } catch (cause) {
        setResponding(null)
        setError(cause instanceof Error ? cause.message : 'Could not send message')
      } finally {
        setIsSending(false)
      }
    },
    [selectedUrl, refresh],
  )

  const createChannel = useCallback(async (name: string, assistant: AssistantConfig) => {
    try {
      const response = await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, assistant }),
      })

      if (!response.ok) {
        setError(await readError(response, 'Could not create conversation'))
        return
      }

      const { channel } = (await response.json()) as { channel: ChannelSummary }
      setChannels((current) => [channel, ...current])
      setSelectedUrl(channel.channelUrl)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create conversation')
    }
  }, [])

  const deleteChannel = useCallback(async (channelUrl: string) => {
    try {
      const response = await fetch(`/api/channels/${channelUrl}`, { method: 'DELETE' })
      if (!response.ok) {
        setError(await readError(response, 'Could not delete conversation'))
        return
      }

      setChannels((current) => {
        const remaining = current.filter((channel) => channel.channelUrl !== channelUrl)
        // Deleting the open conversation must move the selection, or the thread
        // pane would keep rendering a channel that no longer exists.
        setSelectedUrl((selected) =>
          selected === channelUrl ? (remaining[0]?.channelUrl ?? null) : selected,
        )
        return remaining
      })
      setThread((current) => (current?.channelUrl === channelUrl ? null : current))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete conversation')
    }
  }, [])

  /** Replaces one channel in place after its configuration is edited. */
  const applyChannelUpdate = useCallback((updated: ChannelSummary) => {
    setChannels((current) =>
      current.map((channel) => (channel.channelUrl === updated.channelUrl ? updated : channel)),
    )
  }, [])

  const deleteAllChannels = useCallback(async () => {
    try {
      const response = await fetch('/api/channels', { method: 'DELETE' })
      if (!response.ok) {
        setError(await readError(response, 'Could not delete conversations'))
        return
      }
      setChannels([])
      setSelectedUrl(null)
      setThread(null)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete conversations')
    }
  }, [])

  // Only surface the in-flight reply — and anything derived from it — on the
  // conversation it belongs to, so switching bots mid-turn can't leak the
  // previous bot's "responding" state (its pulsing header dot included).
  const visibleResponding = responding?.channelUrl === selectedUrl ? responding : null

  return {
    channels,
    selectedChannel,
    selectedUrl,
    selectChannel: setSelectedUrl,
    createChannel,
    deleteChannel,
    deleteAllChannels,
    applyChannelUpdate,
    messages: thread?.channelUrl === selectedUrl ? (thread?.messages ?? []) : [],
    isBootstrapping,
    isLoadingMessages,
    isSending,
    responding: visibleResponding,
    error,
    sendMessage,
    screens: screenState?.channelUrl === selectedUrl ? screenState.screens : [],
    activeScreenId,
    openScreen: setActiveScreenId,
    hasLiveScreens: (visibleResponding?.screens.length ?? 0) > 0,
  }
}
