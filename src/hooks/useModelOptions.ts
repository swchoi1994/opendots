'use client'

import { useEffect, useState } from 'react'
import { STATIC_MODEL_OPTIONS, type ModelOption } from '@/lib/domain/models'

export interface ModelOptionsState {
  options: ModelOption[]
  /**
   * True once the live `/api/models` list has answered for this page load.
   * False while loading and after a failed fetch: the static fallback marks
   * every Claude entry `available: true` regardless of ANTHROPIC_API_KEY, so
   * callers must not treat a Claude entry as available until this is true.
   */
  confirmed: boolean
}

/** One request per page load, shared by every picker on the page. A failure is not cached. */
let pending: Promise<ModelOptionsState> | null = null

function loadModelOptions(): Promise<ModelOptionsState> {
  pending ??= fetch('/api/models')
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
    .then((body: { models: ModelOption[] }) => ({ options: body.models, confirmed: true }))
    .catch(() => {
      pending = null
      return { options: STATIC_MODEL_OPTIONS, confirmed: false }
    })
  return pending
}

/**
 * The model picker's options: the server's live list (Claude when a key is
 * set, local Ollama models), and the static Claude list until it answers.
 * Pulling a new Ollama model shows up after a page reload.
 */
export function useModelOptions(): ModelOptionsState {
  const [state, setState] = useState<ModelOptionsState>({ options: STATIC_MODEL_OPTIONS, confirmed: false })
  useEffect(() => {
    let active = true
    void loadModelOptions().then((next) => {
      if (active) setState(next)
    })
    return () => {
      active = false
    }
  }, [])
  return state
}
