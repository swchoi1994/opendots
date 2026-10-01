'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { BotAvatar } from './BotAvatar'
import { CloseIcon, TrashIcon } from './icons'
import {
  DEFAULT_ASSISTANT,
  DEFAULT_GUARDRAILS,
  DEFAULT_MEMORY,
  MODEL_CATALOG,
  TOOL_CATALOG,
  type AssistantConfig,
  type ToolName,
} from '@/lib/domain/assistant'
import { AVATAR_COLORS, AVATAR_SHAPES, avatarFromName, type BotAvatar as BotAvatarModel } from '@/lib/domain/avatar'
import type { Skill } from '@/lib/domain/skill'

interface NewBotDialogProps {
  open: boolean
  onClose: () => void
  onCreate: (name: string, assistant: AssistantConfig) => Promise<void>
}

/** Shared with `BotPanel.tsx`, which imports it from here. */
export function AvatarPicker({
  value,
  onChange,
}: {
  value: BotAvatarModel
  onChange: (next: BotAvatarModel) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Avatar shape">
        {AVATAR_SHAPES.map((shape) => (
          <button
            key={shape}
            type="button"
            role="radio"
            aria-checked={value.shape === shape}
            aria-label={shape}
            onClick={() => onChange({ ...value, shape })}
            className={`cursor-pointer rounded-xl p-1 ring-2 transition ${value.shape === shape ? 'ring-ink-900' : 'ring-transparent hover:bg-surface'}`}
          >
            <BotAvatar avatar={{ shape, color: value.color }} size={32} />
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Avatar colour">
        {AVATAR_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={value.color === color}
            aria-label={color}
            onClick={() => onChange({ ...value, color })}
            className={`h-6 w-6 cursor-pointer rounded-full ring-2 ring-offset-2 transition ${value.color === color ? 'ring-ink-900' : 'ring-transparent'}`}
            style={{ background: `var(--color-av-${color})` }}
          />
        ))}
      </div>
    </div>
  )
}

const CUSTOM_MODEL_VALUE = '__custom__'

/**
 * Shared with `BotPanel.tsx`, which imports it from here.
 *
 * A single `model` string is the source of truth: the select shows "Other…"
 * whenever `value` is not one of the catalog ids, and the text input (shown
 * only then) edits that same string directly. That is what lets a saved
 * custom id like `claude-opus-4-1` redisplay correctly on remount, instead of
 * a separate "custom model" field that starts blank until touched.
 */
export function ModelSelect({
  value,
  onChange,
  idPrefix = 'model',
}: {
  value: string
  onChange: (model: string) => void
  idPrefix?: string
}) {
  const isCustom = !MODEL_CATALOG.some((entry) => entry.id === value)
  const customInputRef = useRef<HTMLInputElement>(null)

  return (
    <>
      <select
        id={`${idPrefix}-select`}
        aria-label="Model"
        value={isCustom ? CUSTOM_MODEL_VALUE : value}
        onChange={(event) => {
          const next = event.target.value
          if (next === CUSTOM_MODEL_VALUE) {
            onChange('')
            // The input does not exist yet in this render; focus it once React
            // has committed the one that follows.
            requestAnimationFrame(() => customInputRef.current?.focus())
          } else {
            onChange(next)
          }
        }}
        className="rounded-lg border border-line px-3 py-2 text-[14px] outline-none focus:border-ink-900"
      >
        {MODEL_CATALOG.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label}
          </option>
        ))}
        <option value={CUSTOM_MODEL_VALUE}>Other…</option>
      </select>
      {isCustom && (
        <input
          ref={customInputRef}
          id={`${idPrefix}-custom`}
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="claude-sonnet-4-5-20250929"
          className="mt-1 rounded-lg border border-line px-3 py-2 text-[14px] outline-none focus:border-ink-900"
        />
      )}
    </>
  )
}

/**
 * Bot creation: a bot is configured up front with its name, avatar, the model
 * that answers, the role prompt that shapes it, and which tools it may use.
 */
export function NewBotDialog({ open, onClose, onCreate }: NewBotDialogProps) {
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState<BotAvatarModel>(avatarFromName(''))
  const [avatarTouched, setAvatarTouched] = useState(false)
  const [model, setModel] = useState(DEFAULT_ASSISTANT.model)
  const [systemMessage, setSystemMessage] = useState(DEFAULT_ASSISTANT.systemMessage)
  const [tools, setTools] = useState<ToolName[]>(DEFAULT_ASSISTANT.tools)
  const [memoryEnabled, setMemoryEnabled] = useState(DEFAULT_MEMORY.enabled)
  const [memoryWindow, setMemoryWindow] = useState(DEFAULT_MEMORY.windowMessages)
  const [guardrailsEnabled, setGuardrailsEnabled] = useState(DEFAULT_GUARDRAILS.enabled)
  const [skills, setSkills] = useState<Skill[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function handleNameChange(next: string) {
    setName(next)
    // Follow the typed name until the user picks a shape or colour manually.
    if (!avatarTouched) setAvatar(avatarFromName(next))
  }

  function handleAvatarChange(next: BotAvatarModel) {
    setAvatarTouched(true)
    setAvatar(next)
  }

  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  function toggleTool(tool: ToolName) {
    setTools((current) =>
      current.includes(tool) ? current.filter((item) => item !== tool) : [...current, tool],
    )
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setIsUploading(true)
    setUploadError(null)

    try {
      for (const file of Array.from(files)) {
        // Read in the browser and post JSON: no multipart handling on the
        // server, and the text is what gets indexed anyway.
        const content = await file.text()
        const response = await fetch('/api/skills', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: file.name, content }),
        })

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string }
          setUploadError(body.error ?? `Could not upload ${file.name}`)
          continue
        }

        const { skill } = (await response.json()) as { skill: Skill }
        setSkills((current) => [...current, skill])
      }
    } catch (cause) {
      setUploadError(cause instanceof Error ? cause.message : 'Could not upload skill')
    } finally {
      setIsUploading(false)
      // Clear the input so re-selecting the same file fires change again.
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function removeSkill(skillId: string) {
    setSkills((current) => current.filter((skill) => skill.id !== skillId))
    // Best-effort cleanup; the bot simply will not reference it.
    await fetch(`/api/skills/${skillId}`, { method: 'DELETE' }).catch(() => undefined)
  }

  function resetState() {
    setName('')
    setAvatar(avatarFromName(''))
    setAvatarTouched(false)
    setModel(DEFAULT_ASSISTANT.model)
    setSystemMessage(DEFAULT_ASSISTANT.systemMessage)
    setTools(DEFAULT_ASSISTANT.tools)
    setMemoryEnabled(DEFAULT_MEMORY.enabled)
    setMemoryWindow(DEFAULT_MEMORY.windowMessages)
    setGuardrailsEnabled(DEFAULT_GUARDRAILS.enabled)
    setSkills([])
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!name.trim() || isSubmitting) return

    const resolvedModel = model.trim() || DEFAULT_ASSISTANT.model

    setIsSubmitting(true)
    try {
      await onCreate(name.trim(), {
        provider: 'claude_code',
        model: resolvedModel,
        name: name.trim(),
        avatar,
        systemMessage,
        tools,
        memory: { enabled: memoryEnabled, windowMessages: memoryWindow },
        guardrails: { ...DEFAULT_GUARDRAILS, enabled: guardrailsEnabled },
        skillIds: skills.map((skill) => skill.id),
        browser: DEFAULT_ASSISTANT.browser,
      })
      resetState()
      onClose()
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    /*
     * The OVERLAY scrolls, not the panel. A panel with max-height + internal
     * overflow still gets clipped when the viewport is shorter than the panel's
     * minimum; scrolling the full-screen container instead means the dialog is
     * always reachable in full, and `min-h-full` + `items-center` keeps it
     * centred whenever there is room.
     */
    <div className="fixed inset-0 z-50 overflow-y-auto overscroll-contain">
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="fixed inset-0 cursor-default bg-ink-900/40"
      />

      <div className="relative flex min-h-full items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-bot-title"
          className="relative z-10 w-full max-w-[480px] rounded-2xl bg-white p-5 shadow-xl"
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <h2 id="new-bot-title" className="text-[17px] font-bold text-ink-900">
                New bot
              </h2>
              <p className="mt-0.5 text-[12px] text-ink-500">
                Give your new teammate a name, a role, and the tools it may use.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="cursor-pointer rounded-full p-1 text-ink-500 transition-colors hover:bg-line"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-semibold text-ink-700">Name</span>
              <input
                type="text"
                value={name}
                onChange={(event) => handleNameChange(event.target.value)}
                placeholder="Apartment Hunter"
                required
                className="rounded-lg border border-line px-3 py-2 text-[14px] outline-none focus:border-ink-900"
              />
            </label>

            <div className="flex flex-col gap-1">
              <span className="text-[12px] font-semibold text-ink-700">Avatar</span>
              <AvatarPicker value={avatar} onChange={handleAvatarChange} />
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-[12px] font-semibold text-ink-700">Model</span>
              <ModelSelect value={model} onChange={setModel} idPrefix="new-bot-model" />
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-semibold text-ink-700">Role prompt</span>
              <textarea
                value={systemMessage}
                onChange={(event) => setSystemMessage(event.target.value)}
                rows={3}
                placeholder="You find apartments that match my filters and summarise new listings every morning."
                className="resize-y rounded-lg border border-line px-3 py-2 text-[14px] outline-none focus:border-ink-900"
              />
            </label>

            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-[12px] font-semibold text-ink-700">Tools</legend>
              {TOOL_CATALOG.map((tool) => (
                <label
                  key={tool.id}
                  className={`flex items-start gap-2.5 rounded-lg border border-line px-3 py-2 ${tool.available ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
                >
                  <input
                    type="checkbox"
                    checked={tools.includes(tool.id)}
                    disabled={!tool.available}
                    onChange={() => toggleTool(tool.id)}
                    className="mt-0.5 accent-ink-900"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="block text-[13px] text-ink-900">{tool.label}</span>
                      {!tool.available && (
                        <span className="rounded-full bg-surface px-1.5 py-0.5 text-[10px] font-medium text-ink-500">
                          coming soon
                        </span>
                      )}
                    </span>
                    <span className="block text-[11px] leading-snug text-ink-500">
                      {tool.description}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>

            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-[12px] font-semibold text-ink-700">
                Short-term memory
              </legend>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line px-3 py-2">
                <input
                  type="checkbox"
                  checked={memoryEnabled}
                  onChange={(event) => setMemoryEnabled(event.target.checked)}
                  className="mt-0.5 accent-ink-900"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] text-ink-900">Remember recent turns</span>
                  <span className="block text-[11px] leading-snug text-ink-500">
                    Replays the last messages as real turns so follow-up questions resolve.
                  </span>
                </span>
              </label>
              {memoryEnabled && (
                <label className="flex items-center gap-2 pl-3">
                  <span className="text-[11px] text-ink-500">Window</span>
                  <input
                    type="number"
                    min={2}
                    max={50}
                    value={memoryWindow}
                    onChange={(event) => setMemoryWindow(Number(event.target.value))}
                    className="w-16 rounded-lg border border-line px-2 py-1 text-[12px] outline-none focus:border-ink-900"
                  />
                  <span className="text-[11px] text-ink-500">messages</span>
                </label>
              )}
            </fieldset>

            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-[12px] font-semibold text-ink-700">Guardrails</legend>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line px-3 py-2">
                <input
                  type="checkbox"
                  checked={guardrailsEnabled}
                  onChange={(event) => setGuardrailsEnabled(event.target.checked)}
                  className="mt-0.5 accent-ink-900"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] text-ink-900">Check inputs and outputs</span>
                  <span className="block text-[11px] leading-snug text-ink-500">
                    Refuses messages carrying credentials, flags prompt injection, and redacts
                    secrets from replies.
                  </span>
                </span>
              </label>
            </fieldset>

            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-[12px] font-semibold text-ink-700">Skills</legend>

              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.markdown,text/markdown"
                multiple
                onChange={(event) => void handleFiles(event.target.files)}
                className="hidden"
                id="skill-upload"
              />
              <label
                htmlFor="skill-upload"
                className="flex cursor-pointer items-center justify-center rounded-lg border border-dashed border-line bg-surface px-3 py-2.5 text-[13px] font-medium text-ink-700 transition-colors hover:border-ink-900"
              >
                {isUploading ? 'Uploading…' : 'Upload skill.md'}
              </label>
              <p className="text-[11px] leading-snug text-ink-500">
                Markdown with optional <code className="font-mono">name</code> /{' '}
                <code className="font-mono">description</code> frontmatter. Uploaded skills are
                indexed and retrieved by Knowledge Search for this bot.
              </p>

              {uploadError && (
                <p role="alert" className="text-[11px] text-rose-700">
                  {uploadError}
                </p>
              )}

              {skills.length > 0 && (
                <ul className="mt-1 flex flex-col gap-1">
                  {skills.map((skill) => (
                    <li
                      key={skill.id}
                      className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-ink-900">{skill.name}</span>
                        <span className="block truncate font-mono text-[11px] text-ink-400">
                          {skill.fileName}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => void removeSkill(skill.id)}
                        aria-label={`Remove skill ${skill.name}`}
                        className="cursor-pointer rounded-full p-1 text-ink-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="cursor-pointer rounded-xl px-4 py-2 text-[14px] font-medium text-ink-700 transition-colors hover:bg-line"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!name.trim() || isSubmitting}
                className="cursor-pointer rounded-xl bg-bubble-own px-4 py-2 text-[14px] font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isSubmitting ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
