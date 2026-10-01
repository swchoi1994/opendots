'use client'

import { useEffect, useState } from 'react'
import { STATIC_MODEL_OPTIONS, type ModelOption } from '@/lib/domain/models'

/** One request per page load, shared by every picker on the page. A failure is not cached. */
let pending: Promise<ModelOption[]> | null = null

function loadModelOptions(): Promise<ModelOption[]> {
  pending ??= fetch('/api/models')
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
    .then((body: { models: ModelOption[] }) => body.models)
    .catch(() => {
      pending = null
      return STATIC_MODEL_OPTIONS
    })
  return pending
}

/**
 * The model picker's options: the server's live list (Claude when a key is
 * set, local Ollama models), and the static Claude list until it answers.
 * Pulling a new Ollama model shows up after a page reload.
 */
export function useModelOptions(): ModelOption[] {
  const [options, setOptions] = useState<ModelOption[]>(STATIC_MODEL_OPTIONS)
  useEffect(() => {
    let active = true
    void loadModelOptions().then((next) => {
      if (active) setOptions(next)
    })
    return () => {
      active = false
    }
  }, [])
  return options
}
