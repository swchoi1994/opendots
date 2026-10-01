import { describeBrain, type BrainStatus } from './claude-code'

/**
 * Env-driven configuration for the brain and knowledge search. Nothing here
 * touches the network at import time, so it is safe during `next build`.
 */

export type VectorStoreKind = 'memory' | 'pgvector'

export interface BrainConfig {
  provider: 'claude_code'
  /** Default model alias for new bots; each bot may override. */
  defaultModel: string
  /** Cap on tool-use rounds per turn. */
  maxTurns: number
  /** Optional spend ceiling per turn; null means none. */
  maxBudgetUsd: number | null
  /** True forces the planner's dry-run answer; the eval sets it. */
  dryRun: boolean
}

export interface RagConfig {
  enabled: boolean
  vectorStore: VectorStoreKind
  topK: number
  minScore: number
  chunkSize: number
  chunkOverlap: number
}

export interface AiConfig {
  brain: BrainConfig
  rag: RagConfig
}

function env(key: string): string | undefined {
  const value = process.env[key]
  return value && value.length > 0 ? value : undefined
}

function envInt(key: string, fallback: number): number {
  const raw = env(key)
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function envFloat(key: string, fallback: number): number {
  const raw = env(key)
  if (!raw) return fallback
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = env(key)
  if (raw === undefined) return fallback
  return raw === '1' || raw.toLowerCase() === 'true'
}

export function getAiConfig(): AiConfig {
  const budget = envFloat('BOT_MAX_BUDGET_USD', 0)
  const vectorStore = env('RAG_VECTOR_STORE')
  return {
    brain: {
      provider: 'claude_code',
      defaultModel: env('CLAUDE_MODEL') ?? 'sonnet',
      maxTurns: envInt('BOT_MAX_TURNS', 12),
      maxBudgetUsd: budget > 0 ? budget : null,
      dryRun: describeBrain().mode === 'dry-run',
    },
    rag: {
      enabled: envBool('RAG_ENABLED', true),
      vectorStore: vectorStore === 'pgvector' ? 'pgvector' : 'memory',
      topK: envInt('RAG_TOP_K', 4),
      minScore: envFloat('RAG_MIN_SCORE', 0.05),
      chunkSize: envInt('RAG_CHUNK_SIZE', 800),
      chunkOverlap: envInt('RAG_CHUNK_OVERLAP', 120),
    },
  }
}

/** Non-secret view for the health endpoint and the UI. */
export function describeAiConfig(config: AiConfig = getAiConfig()): {
  brain: BrainStatus & { defaultModel: string; maxTurns: number }
  rag: { enabled: boolean; vectorStore: VectorStoreKind; topK: number }
} {
  return {
    brain: { ...describeBrain(), defaultModel: config.brain.defaultModel, maxTurns: config.brain.maxTurns },
    rag: { enabled: config.rag.enabled, vectorStore: config.rag.vectorStore, topK: config.rag.topK },
  }
}
