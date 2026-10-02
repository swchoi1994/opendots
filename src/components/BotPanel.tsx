'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { AvatarPicker, ModelSelect } from './NewBotDialog'
import { BotAvatar } from './BotAvatar'
import { CloseIcon } from './icons'
import { ScreenPanel } from './ScreenPanel'
import { useViewer } from './ViewerContext'
import { canToggleTool } from '@/lib/auth/viewer'
import { readError } from '@/lib/client-errors'
import {
  DEFAULT_ASSISTANT,
  TOOL_CATALOG,
  shellBrowserWarning,
  type AssistantConfig,
  type ToolName,
} from '@/lib/domain/assistant'
import type { BotAvatar as BotAvatarModel } from '@/lib/domain/avatar'
import { modelBadge } from '@/lib/domain/models'
import type { Screen, ScreenFrame } from '@/lib/domain/screen'
import type { ChannelSummary } from '@/lib/domain/types'

/** The two tabs of the right-hand panel; the parent owns which one is open. */
export type PanelTab = 'screen' | 'settings'

interface BotPanelProps {
  channel: ChannelSummary
  onClose: () => void
  onSaved: (updated: ChannelSummary) => void
  onDelete: (channelUrl: string) => void
  /** Which of the two tabs is open; controlled by the parent. */
  panelTab: PanelTab
  onTabChange: (tab: PanelTab) => void
  /** All persisted frames for this channel, newest turn first. */
  screens: Screen[]
  /** Frames captured so far in the turn currently in flight. */
  liveScreens: ScreenFrame[]
  activeScreenId: number | null
  onSelectScreen: (screenId: number) => void
  onToggleHeaded: (headed: boolean) => Promise<void>
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line py-2 last:border-b-0">
      <span className="shrink-0 text-[12px] font-semibold text-ink-700">{label}</span>
      <span className="min-w-0 text-right text-[12px] break-words text-ink-900">{children}</span>
    </div>
  )
}

/**
 * Bot info, and editing for the assistant configuration.
 *
 * Read-only channels (the seeded team chats) have no assistant, so the panel
 * shows a plain notice rather than an empty edit form implying a
 * configuration that does not exist.
 */
export function BotPanel({
  channel,
  onClose,
  onSaved,
  onDelete,
  panelTab,
  onTabChange,
  screens,
  liveScreens,
  activeScreenId,
  onSelectScreen,
  onToggleHeaded,
}: BotPanelProps) {
  const assistant = channel.assistant
  const { role } = useViewer()
  const [isEditing, setIsEditing] = useState(false)
  const [name, setName] = useState(assistant?.name ?? channel.name)
  const [avatar, setAvatar] = useState<BotAvatarModel>(assistant?.avatar ?? DEFAULT_ASSISTANT.avatar)
  const [model, setModel] = useState(assistant?.model ?? DEFAULT_ASSISTANT.model)
  const [systemMessage, setSystemMessage] = useState(
    assistant?.systemMessage ?? DEFAULT_ASSISTANT.systemMessage,
  )
  const [tools, setTools] = useState<ToolName[]>(assistant?.tools ?? [])
  const [memoryEnabled, setMemoryEnabled] = useState(assistant?.memory.enabled ?? true)
  const [memoryWindow, setMemoryWindow] = useState(assistant?.memory.windowMessages ?? 10)
  const [guardrailsEnabled, setGuardrailsEnabled] = useState(assistant?.guardrails.enabled ?? true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  /*
   * The parent renders this only while open and keys it on the conversation,
   * so opening or switching conversations remounts it with fresh state. That
   * replaces a re-seeding effect, which React Compiler flags — and which would
   * have re-run on every unrelated `assistant` identity change anyway.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  function toggleTool(tool: ToolName) {
    setTools((current) =>
      current.includes(tool) ? current.filter((item) => item !== tool) : [...current, tool],
    )
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!assistant || isSaving) return

    const resolvedModel = model.trim() || assistant.model

    setIsSaving(true)
    setError(null)
    try {
      const next: AssistantConfig = {
        ...assistant,
        name: name.trim() || assistant.name,
        avatar,
        model: resolvedModel,
        systemMessage,
        tools,
        memory: { enabled: memoryEnabled, windowMessages: memoryWindow },
        guardrails: { ...assistant.guardrails, enabled: guardrailsEnabled },
      }

      const response = await fetch(`/api/channels/${channel.channelUrl}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistant: next }),
      })

      if (!response.ok) {
        // The server's reason, e.g. that only admins may turn a tool on.
        setError(await readError(response, 'Could not save configuration'))
        return
      }

      const { channel: updated } = (await response.json()) as { channel: ChannelSummary }
      onSaved(updated)
      setIsEditing(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save configuration')
    } finally {
      setIsSaving(false)
    }
  }

  function handleDeleteClick() {
    if (confirmingDelete) {
      onDelete(channel.channelUrl)
      return
    }
    setConfirmingDelete(true)
  }

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-line bg-white">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
        <h2 className="text-[15px] font-bold text-ink-900">Bot</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close info"
          className="cursor-pointer rounded-full p-1 text-ink-500 transition-colors hover:bg-line"
        >
          <CloseIcon className="h-5 w-5" />
        </button>
      </header>

      <div role="tablist" aria-label="Bot panel" className="flex shrink-0 gap-1 border-b border-line px-4">
        {(['screen', 'settings'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={panelTab === tab}
            onClick={() => onTabChange(tab)}
            className={`cursor-pointer border-b-2 px-2 py-2.5 text-[13px] font-semibold capitalize transition-colors ${
              panelTab === tab
                ? 'border-ink-900 text-ink-900'
                : 'border-transparent text-ink-500 hover:text-ink-900'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {panelTab === 'screen' ? (
          <ScreenPanel
            channel={channel}
            screens={screens}
            liveScreens={liveScreens}
            activeScreenId={activeScreenId}
            onSelect={onSelectScreen}
            onToggleHeaded={onToggleHeaded}
          />
        ) : !assistant ? (
          <p className="text-[12px] text-ink-500">
            This is a plain conversation with no assistant configured, so there is nothing to edit.
          </p>
        ) : !isEditing ? (
          <section>
            <div className="mb-4 flex flex-col items-center gap-2 text-center">
              <BotAvatar avatar={assistant.avatar} size={64} />
              <h3 className="text-[16px] font-bold text-ink-900">{assistant.name}</h3>
              <span className="rounded-full bg-surface px-2.5 py-1 text-[11px] font-medium text-ink-700">
                {modelBadge(assistant.model)}
              </span>
            </div>

            <div className="mb-1 flex items-center justify-between">
              <h3 className="text-[11px] font-bold tracking-wide text-ink-500 uppercase">
                Configuration
              </h3>
              <button
                type="button"
                onClick={() => setIsEditing(true)}
                className="cursor-pointer rounded-full bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-700 transition-colors hover:bg-line"
              >
                Edit
              </button>
            </div>
            <Row label="Tools">{assistant.tools.length > 0 ? assistant.tools.join(', ') : 'none'}</Row>
            <Row label="Memory">
              {assistant.memory.enabled ? `${assistant.memory.windowMessages} messages` : 'off'}
            </Row>
            <Row label="Guardrails">{assistant.guardrails.enabled ? 'on' : 'off'}</Row>
            <Row label="Knowledge">{assistant.skillIds.length} documents</Row>
            <Row label="Workspace">
              <code className="font-mono text-[11px]">
                .opendots/workspaces/{channel.channelUrl}
              </code>
            </Row>

            <div className="mt-3">
              <p className="mb-1 text-[12px] font-semibold text-ink-700">Role prompt</p>
              <p className="rounded-lg bg-surface p-2.5 text-[12px] leading-snug whitespace-pre-wrap text-ink-900">
                {assistant.systemMessage}
              </p>
            </div>

            {role === 'admin' && (
              <div className="mt-5 border-t border-line pt-3">
                <button
                  type="button"
                  onClick={handleDeleteClick}
                  onBlur={() => setConfirmingDelete(false)}
                  className={`w-full cursor-pointer rounded-xl px-3 py-2 text-[13px] font-semibold transition-colors ${
                    confirmingDelete
                      ? 'bg-rose-600 text-white hover:bg-rose-700'
                      : 'text-rose-600 hover:bg-rose-50'
                  }`}
                >
                  {confirmingDelete ? 'Really delete?' : 'Delete bot'}
                </button>
              </div>
            )}
          </section>
        ) : (
          <form onSubmit={handleSave} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-semibold text-ink-700">Name</span>
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Apartment Hunter"
                className="rounded-lg border border-line px-3 py-2 text-[13px] outline-none focus:border-ink-900"
              />
            </label>

            <div className="flex flex-col gap-1">
              <span className="text-[12px] font-semibold text-ink-700">Avatar</span>
              <AvatarPicker value={avatar} onChange={setAvatar} />
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-[12px] font-semibold text-ink-700">Model</span>
              <ModelSelect value={model} onChange={setModel} idPrefix={`bot-panel-${channel.channelUrl}-model`} />
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-semibold text-ink-700">Role prompt</span>
              <textarea
                value={systemMessage}
                onChange={(event) => setSystemMessage(event.target.value)}
                rows={4}
                className="resize-y rounded-lg border border-line px-3 py-2 text-[13px] outline-none focus:border-ink-900"
              />
            </label>

            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-[12px] font-semibold text-ink-700">Tools</legend>
              {TOOL_CATALOG.map((tool) => {
                // Measured against the saved bot, as the server does: a member may untick a granted tool and tick it back.
                const allowed = canToggleTool(role, tool.id, assistant.tools.includes(tool.id))
                const enabled = tool.available && allowed
                return (
                  <label
                    key={tool.id}
                    title={allowed ? undefined : 'Only workspace admins can turn this on'}
                    className={`flex items-center gap-2 text-[12px] ${enabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
                  >
                    <input
                      type="checkbox"
                      checked={tools.includes(tool.id)}
                      disabled={!enabled}
                      onChange={() => toggleTool(tool.id)}
                      className="accent-ink-900"
                    />
                    {tool.label}
                    {!tool.available && (
                      <span className="rounded-full bg-surface px-1.5 py-0.5 text-[10px] font-medium text-ink-500">
                        coming soon
                      </span>
                    )}
                  </label>
                )
              })}
              {shellBrowserWarning(tools) && (
                <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-800">
                  {shellBrowserWarning(tools)}
                </p>
              )}
            </fieldset>

            <label className="flex items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={memoryEnabled}
                onChange={(event) => setMemoryEnabled(event.target.checked)}
                className="accent-ink-900"
              />
              Short-term memory
            </label>
            {memoryEnabled && (
              <label className="flex items-center gap-2 pl-5 text-[11px] text-ink-500">
                Window
                <input
                  type="number"
                  min={2}
                  max={50}
                  value={memoryWindow}
                  onChange={(event) => setMemoryWindow(Number(event.target.value))}
                  className="w-16 rounded-lg border border-line px-2 py-1 text-[12px] outline-none focus:border-ink-900"
                />
                messages
              </label>
            )}

            <label className="flex items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={guardrailsEnabled}
                onChange={(event) => setGuardrailsEnabled(event.target.checked)}
                className="accent-ink-900"
              />
              Guardrails
            </label>

            {error && (
              <p role="alert" className="text-[12px] text-rose-700">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setIsEditing(false)}
                className="cursor-pointer rounded-xl px-3 py-1.5 text-[13px] font-medium text-ink-700 transition-colors hover:bg-line"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSaving}
                className="cursor-pointer rounded-xl bg-bubble-own px-3 py-1.5 text-[13px] font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-40"
              >
                {isSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        )}
      </div>
    </aside>
  )
}
