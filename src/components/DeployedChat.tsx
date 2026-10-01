'use client'

import { useCallback, useEffect, useState } from 'react'
import { ChannelAvatar } from './Avatar'
import { MessageInput } from './MessageInput'
import { MessageThread } from './MessageThread'
import { modelBadge } from '@/lib/domain/models'
import type { ChannelSummary, MessageWithReceipt } from '@/lib/domain/types'

/**
 * Single-conversation view behind a share link.
 *
 * Deliberately has no sidebar and no channel switching: whoever opens the link
 * gets exactly the deployed conversation and nothing else in the workspace.
 */
interface DeployedChatProps {
  channel: ChannelSummary
  deploymentId: string
  allowPosting: boolean
}

export function DeployedChat({ channel, deploymentId, allowPosting }: DeployedChatProps) {
  const [messages, setMessages] = useState<MessageWithReceipt[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSending, setIsSending] = useState(false)
  const [responding, setResponding] = useState<{ text: string; provenance: null } | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Deployment-scoped endpoints only: a visitor must never be able to address
  // an arbitrary channelUrl, so the channel is derived server-side.
  const load = useCallback(async () => {
    const response = await fetch(`/api/deployments/${deploymentId}/thread`)
    if (!response.ok) throw new Error('Could not load messages')
    const { messages: loaded } = (await response.json()) as { messages: MessageWithReceipt[] }
    setMessages(loaded)
  }, [deploymentId])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        await load()
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load messages')
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [load])

  const sendMessage = useCallback(
    async (text: string) => {
      setIsSending(true)
      try {
        const response = await fetch(`/api/deployments/${deploymentId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text }),
        })

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string }
          setError(body.error ?? 'Could not send message')
          return
        }

        const { expectsReply } = (await response.json()) as { expectsReply?: boolean }
        await load()
        setError(null)
        if (!expectsReply) return

        setResponding({ text: '', provenance: null })
        const stream = await fetch(`/api/deployments/${deploymentId}/respond`, { method: 'POST' })
        if (!stream.ok) {
          setResponding(null)
          setError('Assistant could not respond')
          return
        }

        const reader = stream.body?.getReader()
        if (reader) {
          const decoder = new TextDecoder()
          let buffer = ''
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const frames = buffer.split('\n\n')
            buffer = frames.pop() ?? ''
            for (const raw of frames) {
              if (!raw.includes('event: token')) continue
              const line = raw.split('\n').find((l) => l.startsWith('data:'))
              if (!line) continue
              try {
                const { token } = JSON.parse(line.slice(5).trim()) as { token: string }
                setResponding((current) => (current ? { ...current, text: current.text + token } : current))
              } catch {
                // Skip a malformed frame rather than aborting the stream.
              }
            }
          }
        }

        setResponding(null)
        await load()
      } catch (cause) {
        setResponding(null)
        setError(cause instanceof Error ? cause.message : 'Could not send message')
      } finally {
        setIsSending(false)
      }
    },
    [deploymentId, load],
  )

  return (
    <main className="flex h-screen w-full flex-col overflow-hidden bg-white">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line px-6">
        <span aria-hidden="true">
          <ChannelAvatar channel={channel} size={36} />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-[17px] font-bold text-ink-900">{channel.name}</h1>
          {channel.assistant && (
            <p className="truncate text-[11px] text-ink-500">
              {modelBadge(channel.assistant.model)}
              {channel.assistant.skillIds.length > 0 &&
                ` · ${channel.assistant.skillIds.length} skill(s)`}
            </p>
          )}
        </div>
        <span className="ml-auto shrink-0 rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-semibold text-brand-700">
          Deployed
        </span>
      </header>

      {error && (
        <p role="alert" className="border-b border-line bg-rose-50 px-6 py-2 text-[13px] text-rose-700">
          {error}
        </p>
      )}

      <MessageThread
        messages={messages}
        isLoading={isLoading}
        responding={
          responding
            ? {
                channelUrl: channel.channelUrl,
                text: responding.text,
                provenance: null,
                activity: null,
                installedSkills: [],
                screens: [],
              }
            : null
        }
      />

      <MessageInput
        disabled={channel.isFrozen || !allowPosting}
        isSending={isSending}
        onSend={sendMessage}
        placeholder={
          !allowPosting
            ? 'This conversation is read-only'
            : channel.isFrozen
              ? 'This conversation is frozen'
              : 'Enter message'
        }
      />
    </main>
  )
}
