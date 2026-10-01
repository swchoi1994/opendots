import { getRepository } from '../../repository'
import type { ChatRepository } from '../../repository/chat-repository'
import { getAiConfig, type AiConfig } from '../config'
import { KNOWLEDGE_BASE, type KnowledgeDocument } from './knowledge'

export interface RetrievedChunk {
  documentId: string
  title: string
  source: string
  text: string
  /** Normalised 0..1 relevance. */
  score: number
}

/**
 * The RAG seam. Swapping the memory retriever for Pinecone (or any other
 * store) means implementing this one method — nothing upstream changes.
 */
export interface RetrieveOptions {
  topK?: number
  /**
   * Restricts which uploaded skills are searchable. Undefined means "all
   * skills"; an array (including an empty one) means only those skills, so a
   * conversation never retrieves from a skill it was not configured with.
   */
  skillIds?: string[]
}

export interface Retriever {
  readonly kind: string
  retrieve(query: string, options?: RetrieveOptions): Promise<RetrievedChunk[]>
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'do', 'does', 'for', 'from',
  'has', 'have', 'he', 'her', 'his', 'how', 'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my', 'not',
  'of', 'on', 'or', 'she', 'should', 'so', 'that', 'the', 'their', 'them', 'they', 'this', 'to',
  'was', 'we', 'were', 'what', 'when', 'which', 'who', 'why', 'will', 'with', 'you', 'your',
])

/*
 * Ordered longest-first so "-ing" wins over "-g"-style partial matches.
 * Deliberately conservative: this collapses inflections (eat/eating,
 * lethargy/lethargic) without attempting real morphology.
 */
const SUFFIXES = ['ingly', 'ing', 'edly', 'ed', 'ies', 'es', 'ly', 'ic', 's', 'y']

function stem(token: string): string {
  if (token.length <= 3) return token
  for (const suffix of SUFFIXES) {
    // Keep a root of at least 3 characters so "dogs"->"dog" but "ies"->"ies".
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      return token.slice(0, -suffix.length)
    }
  }
  return token
}

/**
 * Shared by indexing and querying — that symmetry is the whole point. Any
 * normalisation applied to only one side silently destroys recall, which is
 * how "won't" in a document failed to match "wont" from a user.
 */
function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    // Elide apostrophes rather than splitting on them: "won't" -> "wont",
    // matching what people actually type.
    .replace(/['‘’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
    .map(stem)
}

interface Chunk {
  documentId: string
  title: string
  source: string
  text: string
  termFrequency: Map<string, number>
  length: number
}

/** Split on word boundaries so a chunk never ends mid-token. */
function chunkDocument(doc: KnowledgeDocument, size: number, overlap: number): string[] {
  const words = doc.text.split(/\s+/).filter(Boolean)
  // `size` is expressed in characters; convert to an approximate word count.
  const wordsPerChunk = Math.max(20, Math.floor(size / 6))
  const stride = Math.max(1, wordsPerChunk - Math.floor(overlap / 6))

  if (words.length <= wordsPerChunk) return [doc.text]

  const chunks: string[] = []
  for (let start = 0; start < words.length; start += stride) {
    chunks.push(words.slice(start, start + wordsPerChunk).join(' '))
    if (start + wordsPerChunk >= words.length) break
  }
  return chunks
}

function buildChunks(docs: KnowledgeDocument[], config: AiConfig): Chunk[] {
  return docs.flatMap((doc) =>
    chunkDocument(doc, config.rag.chunkSize, config.rag.chunkOverlap).map((text) => {
      const tokens = tokenize(text)
      const termFrequency = new Map<string, number>()
      for (const token of tokens) {
        termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1)
      }
      return {
        documentId: doc.id,
        title: doc.title,
        source: doc.source,
        text,
        termFrequency,
        length: Math.max(1, tokens.length),
      }
    }),
  )
}

function buildIdf(chunks: Chunk[]): Map<string, number> {
  const documentFrequency = new Map<string, number>()
  for (const chunk of chunks) {
    for (const term of chunk.termFrequency.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
    }
  }

  const idf = new Map<string, number>()
  for (const [term, freq] of documentFrequency) {
    // Smoothed IDF; always positive so a term never subtracts from a score.
    idf.set(term, Math.log(1 + chunks.length / freq))
  }
  return idf
}

/**
 * Lexical TF-IDF retriever over an in-process corpus.
 *
 * Chosen as the default because it needs no API key, no network, and no index
 * provisioning — retrieval is demonstrable the moment the app boots. It is
 * genuinely weaker than dense embeddings on paraphrase, which is exactly why
 * `Retriever` exists as an interface.
 */
export class InMemoryRetriever implements Retriever {
  readonly kind = 'memory'

  private readonly chunks: Chunk[]
  private readonly idf: Map<string, number>
  private readonly config: AiConfig

  constructor(docs: KnowledgeDocument[] = KNOWLEDGE_BASE, config: AiConfig = getAiConfig()) {
    this.config = config
    this.chunks = buildChunks(docs, config)
    this.idf = buildIdf(this.chunks)
  }

  async retrieve(query: string, options: RetrieveOptions = {}): Promise<RetrievedChunk[]> {
    const topK = options.topK ?? this.config.rag.topK
    const terms = tokenize(query)
    if (terms.length === 0) return []

    // Skill documents carry the skill id as their documentId; corpus documents
    // never start with "skill_", so they are always searchable.
    const allowed = options.skillIds ? new Set(options.skillIds) : null
    const searchable = allowed
      ? this.chunks.filter(
          (chunk) => !chunk.documentId.startsWith('skill_') || allowed.has(chunk.documentId),
        )
      : this.chunks

    // Normalising by the query's own IDF mass keeps scores comparable across
    // queries of different lengths, so `minScore` means the same thing for all.
    const idfMass = terms.reduce((sum, term) => sum + (this.idf.get(term) ?? 0), 0)
    if (idfMass === 0) return []

    return searchable
      .map((chunk) => {
        let score = 0
        for (const term of terms) {
          const tf = chunk.termFrequency.get(term)
          if (!tf) continue
          const weight = this.idf.get(term) ?? 0
          // Saturating TF: a term appearing 5 times is not 5x more relevant.
          score += weight * (tf / (tf + 1.2))
        }
        return {
          documentId: chunk.documentId,
          title: chunk.title,
          source: chunk.source,
          text: chunk.text,
          score: score / idfMass,
        }
      })
      .filter((chunk) => chunk.score >= this.config.rag.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  }
}

export class RetrieverNotConfiguredError extends Error {
  constructor(kind: string, missing: string) {
    super(`Vector store "${kind}" is selected but ${missing} is not set.`)
    this.name = 'RetrieverNotConfiguredError'
  }
}

interface CacheEntry {
  /** Sorted, comma-joined skill ids the retriever was built from. */
  ids: string
  retriever: Retriever
}

/**
 * Keyed by repository instance (not a single global), so an injected fake
 * repository in a test never shares a cache entry with the real one — and in
 * production there is only ever one repository instance anyway.
 */
const cache = new WeakMap<ChatRepository, CacheEntry>()

/**
 * Knowledge Search draws on two sources: the built-in seed corpus and every
 * uploaded skill, read through the repository's `listSkills()` /
 * `listSkillIds()` — the same seam every route uses — so indexing follows
 * whichever store `DATA_STORE` selects rather than being wired to the
 * in-memory store specifically. `repo` defaults to the app's repository but
 * is injectable so tests can pass a fake one without touching `DATA_STORE`.
 *
 * Every call queries `listSkillIds()` — ids only, no bodies, so under
 * Postgres this is one small indexed `SELECT skill_id` rather than a row set
 * carrying every skill's full text. The (potentially expensive) `listSkills()`
 * body fetch and index rebuild only run when that id set actually changed
 * since the last check, so uploading or deleting a skill takes effect on the
 * very next query, with no restart and no stale window.
 *
 * A blind time-based cache (skip even the id check for N seconds) was tried
 * and rejected: `rag.uploaded_skill` — and the identical real flow of a user
 * uploading a skill and immediately asking about it — mutates and re-queries
 * inside any TTL worth having, so it would silently serve a stale index for
 * that whole window. Always checking `listSkillIds()` keeps that fast without
 * ever being wrong.
 */
export async function getRetriever(
  config: AiConfig = getAiConfig(),
  repo: ChatRepository = getRepository(),
): Promise<Retriever> {
  if (config.rag.vectorStore === 'pgvector') {
    // Semantic retrieval returns with local embeddings (Phase 1b). Until then a
    // clear stop beats a silently-lexical "pgvector".
    throw new RetrieverNotConfiguredError('pgvector', 'local embeddings (planned for Phase 1b); use RAG_VECTOR_STORE=memory')
  }

  const ids = await repo.listSkillIds()
  const idsKey = ids.slice().sort().join(',')

  const entry = cache.get(repo)
  if (entry && entry.ids === idsKey) return entry.retriever

  const skills = await repo.listSkills()
  const skillDocuments: KnowledgeDocument[] = skills.map((skill) => ({
    id: skill.id,
    title: skill.name,
    source: `skill/${skill.fileName}`,
    // Fold the description into the indexed text; it is often the most
    // query-like sentence in the whole document.
    text: `${skill.description}\n\n${skill.body}`,
  }))

  const retriever = new InMemoryRetriever([...KNOWLEDGE_BASE, ...skillDocuments], config)
  cache.set(repo, { ids: idsKey, retriever })
  return retriever
}
