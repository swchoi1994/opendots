# OpenDots A: Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the imported EigenBots code run on Claude (API key) or local Ollama models, store data in embedded PGlite by default, keep bots' file tools inside their own workspace, and ship it with a license, README and CI.

**Architecture:** One agent loop (Claude Agent SDK) for every model; the provider is chosen per run by building a different subprocess environment (`ANTHROPIC_API_KEY`, or `ANTHROPIC_BASE_URL` pointed at Ollama). Storage goes through a small `Db` interface with two implementations (PGlite, `pg` Pool) behind the existing `PostgresChatRepository`; migrations apply themselves on first use. A `PreToolUse` hook confines file tools to the bot's workspace on every call.

**Tech Stack:** Next.js 16.2.12, React 19, TypeScript 5.9 strict, `@anthropic-ai/claude-agent-sdk` 0.3.286, `@electric-sql/pglite` 0.5.8 + `@electric-sql/pglite-pgvector` 0.0.9, `pg` 8, node:test via `tsx --test`, pnpm 11.

**Spec:** `docs/specs/2026-10-01-opendots-core-design.md` (roadmap: `docs/specs/2026-10-01-opendots-roadmap.md`)

## Global Constraints

- Repository: `~/Documents/opendots` (private `github.com/swchoi1994/opendots`). Work on a feature branch `feat/core`; merge through a pull request.
- Code style matches the codebase: 2-space indent, no semicolons, single quotes, `node:` import prefixes, comments explain *why*.
- Tests: `node:test` + `node:assert/strict`, files named `*.test.ts` next to the code. Unit tests make **no network calls** and spawn no CLI.
- Never pass, read for auth, or document `CLAUDE_CODE_OAUTH_TOKEN`, `claude login` or `claude setup-token`. Claude runs only through `ANTHROPIC_API_KEY`. (Agent SDK policy: "Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products.")
- User-facing copy never calls the product "Claude Code". "Claude" names the model family; "Powered by Claude" is allowed where true.
- Model ids: `default` | `ollama/<name>` | anything else = Anthropic API model (alias `sonnet`/`opus`/`haiku` or a full id).
- Environment variables (exact names): `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `OLLAMA_HOST` (default `http://localhost:11434`), `OPENDOTS_DEFAULT_MODEL`, `DATA_STORE` (`pglite` default | `postgres` | `memory`), `DATABASE_URL`, `OPENDOTS_DATA_DIR` (default `./.opendots`), `OPENDOTS_WORKSPACES_DIR`, `BRAIN_DRY_RUN`, `BOT_MAX_TURNS`, `BOT_MAX_BUDGET_USD`, `DEPLOYMENT_SESSION_SECRET`, plus the unchanged `RAG_*`, `AGENT_BROWSER_BIN`, `OPENDOTS_BROWSER_VIEWPORT`, `OPENDOTS_SCREENSHOT_QUALITY`, `OPENDOTS_BROWSER_TIMEOUT_MS`. `CLAUDE_MODEL` is removed.
- No existing OpenDots databases exist (the project is new), so changed defaults need no data migration for old rows; Task 2 states this explicitly.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  ```
- zsh is the shell: quote globs (`--include='*.ts'`) and never write a bare `===` in shell commands.

---

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `src/lib/data-dir.ts` | new | Where OpenDots writes locally (`OPENDOTS_DATA_DIR`) |
| `src/lib/domain/models.ts` | new | Pure model-id rules: `default`, `ollama/…`, labels, static options |
| `src/lib/ai/model-catalog.ts` | new | Server side: Ollama host, local model list, default-model resolution, picker options |
| `src/app/api/models/route.ts` | new | `GET /api/models` for the picker |
| `src/lib/ai/brain-env.ts` | new | The CLI subprocess environment per provider |
| `src/lib/ai/tools/workspace-guard.ts` | new | `checkWorkspacePath` + the `PreToolUse` hook |
| `src/lib/ai/brain.ts` | renamed from `claude-code.ts` | `runBot`: pre-flight, provider env, hook, events |
| `src/lib/db.ts` | rewritten | `Db` interface, PGlite and `pg` implementations, `getDb()` |
| `src/lib/migrate.ts` | new | Applies `db/*.sql` once each, recorded in `schema_migrations` |
| `src/lib/repository/contract.ts` | new | Shared repository test suite (memory + PGlite) |
| `src/lib/repository/postgres-store.ts` | modified | Takes a `Db`; seed uses `db.transaction` |
| `src/hooks/useModelOptions.ts` | new | Client hook: picker options from `/api/models` |
| `LICENSE`, `README.md`, `.env.example`, `.github/workflows/ci.yml`, `docker-compose.yml`, `Dockerfile` | new/rewritten | Packaging |

---

### Task 1: Groundwork — Agent SDK 0.3.286 and the data directory

**Files:**
- Modify: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` (via pnpm)
- Create: `src/lib/data-dir.ts`, `src/lib/data-dir.test.ts`
- Modify: `src/lib/bots/workspace.ts:11-15`
- Modify: `src/lib/bots/workspace.test.ts` (add one test)

**Interfaces:**
- Produces: `dataDir(env?: NodeJS.ProcessEnv): string` — absolute path, default `resolve('.opendots')`.
- Produces: `workspacesRoot()` now defaults to `join(dataDir(), 'workspaces')`.

- [ ] **Step 1: Create the branch**

```bash
cd ~/Documents/opendots && git checkout -b feat/core
```

- [ ] **Step 2: Upgrade the Agent SDK**

```bash
pnpm add @anthropic-ai/claude-agent-sdk@0.3.286
```

If pnpm refuses because of the release-age policy (an error naming `minimumReleaseAge`), replace every `0.3.258` entry under `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` with these and re-run the command:

```yaml
minimumReleaseAgeExclude:
  - '@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.286'
  - '@anthropic-ai/claude-agent-sdk-darwin-x64@0.3.286'
  - '@anthropic-ai/claude-agent-sdk-linux-arm64-musl@0.3.286'
  - '@anthropic-ai/claude-agent-sdk-linux-arm64@0.3.286'
  - '@anthropic-ai/claude-agent-sdk-linux-x64-musl@0.3.286'
  - '@anthropic-ai/claude-agent-sdk-linux-x64@0.3.286'
  - '@anthropic-ai/claude-agent-sdk-win32-arm64@0.3.286'
  - '@anthropic-ai/claude-agent-sdk-win32-x64@0.3.286'
  - '@anthropic-ai/claude-agent-sdk@0.3.286'
```

Expected: `package.json` shows `"@anthropic-ai/claude-agent-sdk": "^0.3.286"` (or `0.3.286`).

- [ ] **Step 3: Confirm nothing regressed with the new SDK**

Run: `pnpm typecheck && pnpm test && pnpm eval`
Expected: typecheck exit 0; all tests pass; eval prints `15 passed, 2 skipped`.

- [ ] **Step 4: Write the failing tests for the data directory**

`src/lib/data-dir.test.ts`:

```ts
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { dataDir } from './data-dir'

test('dataDir defaults to ./.opendots and follows OPENDOTS_DATA_DIR', () => {
  assert.equal(dataDir({}), resolve('.opendots'))
  assert.equal(dataDir({ OPENDOTS_DATA_DIR: '' }), resolve('.opendots'), 'an empty value is the default, not the cwd')
  assert.equal(dataDir({ OPENDOTS_DATA_DIR: '/srv/opendots' }), '/srv/opendots')
  assert.equal(dataDir({ OPENDOTS_DATA_DIR: 'data' }), resolve('data'))
})
```

In `src/lib/bots/workspace.test.ts`, change `import { join } from 'node:path'` to `import { join, resolve } from 'node:path'` (`workspacesRoot` is already imported), then append:

```ts
test('workspaces live under the data dir unless OPENDOTS_WORKSPACES_DIR overrides them', () => {
  const saved = { data: process.env.OPENDOTS_DATA_DIR, ws: process.env.OPENDOTS_WORKSPACES_DIR }
  try {
    delete process.env.OPENDOTS_WORKSPACES_DIR
    process.env.OPENDOTS_DATA_DIR = '/srv/opendots'
    assert.equal(workspacesRoot(), join('/srv/opendots', 'workspaces'))
    process.env.OPENDOTS_WORKSPACES_DIR = 'elsewhere'
    assert.equal(workspacesRoot(), resolve('elsewhere'))
  } finally {
    if (saved.data === undefined) delete process.env.OPENDOTS_DATA_DIR
    else process.env.OPENDOTS_DATA_DIR = saved.data
    if (saved.ws === undefined) delete process.env.OPENDOTS_WORKSPACES_DIR
    else process.env.OPENDOTS_WORKSPACES_DIR = saved.ws
  }
})
```

- [ ] **Step 5: Run them to see them fail**

Run: `pnpm exec tsx --test src/lib/data-dir.test.ts src/lib/bots/workspace.test.ts`
Expected: FAIL — `Cannot find module './data-dir'`.

- [ ] **Step 6: Implement**

`src/lib/data-dir.ts`:

```ts
import { resolve } from 'node:path'

/**
 * Everything OpenDots writes locally lives under one directory: the embedded
 * database (`db/`), bot workspaces (`workspaces/`) and the bots' own Claude
 * configuration (`claude/`). One variable moves all of it, which is what a
 * container volume or a backup wants.
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.OPENDOTS_DATA_DIR || '.opendots')
}
```

In `src/lib/bots/workspace.ts`, replace

```ts
import { relative, resolve, isAbsolute } from 'node:path'
```
```ts
const DEFAULT_ROOT = './.opendots/workspaces'

export function workspacesRoot(): string {
  return resolve(process.env.OPENDOTS_WORKSPACES_DIR || DEFAULT_ROOT)
}
```

with

```ts
import { isAbsolute, join, relative, resolve } from 'node:path'
import { dataDir } from '../data-dir'
```
```ts
export function workspacesRoot(): string {
  return resolve(process.env.OPENDOTS_WORKSPACES_DIR || join(dataDir(), 'workspaces'))
}
```

- [ ] **Step 7: Run the full suite**

Run: `pnpm typecheck && pnpm test`
Expected: exit 0, all pass.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml src/lib/data-dir.ts src/lib/data-dir.test.ts src/lib/bots/workspace.ts src/lib/bots/workspace.test.ts
git commit -m "chore: Agent SDK 0.3.286 and a single OpenDots data directory

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Model ids, the model list, and the `default` model

**Files:**
- Create: `src/lib/domain/models.ts`, `src/lib/domain/models.test.ts`
- Create: `src/lib/ai/model-catalog.ts`, `src/lib/ai/model-catalog.test.ts`
- Create: `src/app/api/models/route.ts`
- Modify: `src/lib/domain/assistant.ts` (remove provider fields and `MODEL_CATALOG`; default model `default`; Files tool copy)
- Modify: `src/lib/domain/assistant.test.ts:5-11`
- Modify: `src/components/NewBotDialog.tsx` (imports; drop `provider` from the created config)
- Modify: `src/lib/ai/agents/bot-turn.ts:164` (dry-run first line)

**Interfaces:**
- Produces (`src/lib/domain/models.ts`): `DEFAULT_MODEL_ID = 'default'`, `OLLAMA_PREFIX = 'ollama/'`, `type ProviderId = 'anthropic' | 'ollama'`, `interface ResolvedModel { provider: ProviderId; sdkModel: string }`, `interface ModelOption { id: string; label: string; provider: ProviderId | 'default'; available: boolean }`, `CLAUDE_MODELS: ModelOption[]`, `STATIC_MODEL_OPTIONS: ModelOption[]`, `resolveModel(model: string): ResolvedModel` (throws for `default` and for an empty Ollama name), `modelBadge(model: string): string`.
- Produces (`src/lib/ai/model-catalog.ts`): `DEFAULT_OLLAMA_HOST`, `ollamaHost(env?): string`, `interface OllamaModel { name: string; tools: boolean }`, `listOllamaModels(host?, fetchFn?, timeoutMs?): Promise<OllamaModel[] | null>` (null = unreachable), `interface CatalogDeps { env?: NodeJS.ProcessEnv; listModels?: () => Promise<OllamaModel[] | null> }`, `resolveDefaultModel(deps?): Promise<string>`, `buildModelOptions(deps?): Promise<{ options: ModelOption[]; defaultModel: string; ollama: { host: string; reachable: boolean } }>`.
- Changes: `AssistantConfig` loses `provider`; `LlmProviderId`, `ProviderDescriptor`, `PROVIDER_CATALOG`, `isProviderId`, `MODEL_CATALOG` are deleted (verified importers: only `NewBotDialog.tsx` imports `MODEL_CATALOG`; nothing else imports the others).

- [ ] **Step 1: Write the failing tests for model ids**

`src/lib/domain/models.test.ts`:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_MODEL_ID, STATIC_MODEL_OPTIONS, modelBadge, resolveModel } from './models'

test('resolveModel routes ollama/ ids to Ollama and everything else to the Anthropic API', () => {
  assert.deepEqual(resolveModel('ollama/qwq:latest'), { provider: 'ollama', sdkModel: 'qwq:latest' })
  assert.deepEqual(resolveModel('  ollama/llama3.1:8b '), { provider: 'ollama', sdkModel: 'llama3.1:8b' })
  assert.deepEqual(resolveModel('sonnet'), { provider: 'anthropic', sdkModel: 'sonnet' })
  assert.deepEqual(resolveModel('claude-sonnet-5'), { provider: 'anthropic', sdkModel: 'claude-sonnet-5' })
})

test('resolveModel refuses ids that are not concrete', () => {
  assert.throws(() => resolveModel(DEFAULT_MODEL_ID), /resolve "default" first/)
  assert.throws(() => resolveModel('ollama/'), /needs a model name/)
})

test('modelBadge names the provider without throwing on odd input', () => {
  assert.equal(modelBadge('default'), 'Default model')
  assert.equal(modelBadge('ollama/qwq:latest'), 'Ollama · qwq:latest')
  assert.equal(modelBadge('ollama/'), 'Ollama · ?')
  assert.equal(modelBadge('sonnet'), 'Claude · sonnet')
  assert.equal(modelBadge('claude-opus-5-5'), 'Claude · claude-opus-5-5')
  assert.equal(modelBadge('openai/gpt-5'), 'API · openai/gpt-5', 'a non-Claude model behind ANTHROPIC_BASE_URL is not labelled Claude')
})

test('the static options start with the default entry', () => {
  assert.equal(STATIC_MODEL_OPTIONS[0]?.id, DEFAULT_MODEL_ID)
  assert.deepEqual(STATIC_MODEL_OPTIONS.slice(1).map((o) => o.id), ['sonnet', 'opus', 'haiku'])
})
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm exec tsx --test src/lib/domain/models.test.ts`
Expected: FAIL — `Cannot find module './models'`.

- [ ] **Step 3: Implement `src/lib/domain/models.ts`**

```ts
/**
 * A bot's `model` string decides which provider answers:
 *
 *   default          resolved by the server each turn (ai/model-catalog.ts)
 *   ollama/<name>    a local model served by Ollama
 *   anything else    a model behind the Anthropic API (sonnet, opus, haiku,
 *                    a full Claude id, or whatever ANTHROPIC_BASE_URL serves)
 *
 * Pure and dependency-free: the browser imports this for labels.
 */

export const DEFAULT_MODEL_ID = 'default'
export const OLLAMA_PREFIX = 'ollama/'

export type ProviderId = 'anthropic' | 'ollama'

export interface ResolvedModel {
  provider: ProviderId
  /** The model name the SDK sends: without the `ollama/` prefix. */
  sdkModel: string
}

export interface ModelOption {
  id: string
  label: string
  provider: ProviderId | 'default'
  /** False for Claude models while no ANTHROPIC_API_KEY is set. */
  available: boolean
}

export const CLAUDE_MODELS: ModelOption[] = [
  { id: 'sonnet', label: 'Claude Sonnet (balanced)', provider: 'anthropic', available: true },
  { id: 'opus', label: 'Claude Opus (deepest)', provider: 'anthropic', available: true },
  { id: 'haiku', label: 'Claude Haiku (fastest)', provider: 'anthropic', available: true },
]

/** What the picker shows before /api/models answers, or if it cannot. */
export const STATIC_MODEL_OPTIONS: ModelOption[] = [
  { id: DEFAULT_MODEL_ID, label: 'Default', provider: 'default', available: true },
  ...CLAUDE_MODELS,
]

export function resolveModel(model: string): ResolvedModel {
  const trimmed = model.trim()
  if (trimmed === DEFAULT_MODEL_ID) {
    throw new Error('resolveModel needs a concrete model id: resolve "default" first')
  }
  if (trimmed.startsWith(OLLAMA_PREFIX)) {
    const name = trimmed.slice(OLLAMA_PREFIX.length)
    if (!name) throw new Error('An Ollama model id needs a model name after "ollama/"')
    return { provider: 'ollama', sdkModel: name }
  }
  return { provider: 'anthropic', sdkModel: trimmed }
}

const CLAUDE_NAME = /^(sonnet|opus|haiku)$|^claude/i

/** Short label for a bot's model, e.g. "Ollama · qwq:latest". Never throws. */
export function modelBadge(model: string): string {
  const trimmed = model.trim()
  if (trimmed === DEFAULT_MODEL_ID) return 'Default model'
  if (trimmed.startsWith(OLLAMA_PREFIX)) return `Ollama · ${trimmed.slice(OLLAMA_PREFIX.length) || '?'}`
  return `${CLAUDE_NAME.test(trimmed) ? 'Claude' : 'API'} · ${trimmed}`
}
```

- [ ] **Step 4: Run the model-id tests**

Run: `pnpm exec tsx --test src/lib/domain/models.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing tests for the catalog**

`src/lib/ai/model-catalog.test.ts`:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildModelOptions, listOllamaModels, ollamaHost, resolveDefaultModel, type OllamaModel } from './model-catalog'

const qwq: OllamaModel = { name: 'qwq:latest', tools: true }
const phi: OllamaModel = { name: 'phi3:latest', tools: false }

test('ollamaHost accepts the forms Ollama itself accepts', () => {
  assert.equal(ollamaHost({}), 'http://localhost:11434')
  assert.equal(ollamaHost({ OLLAMA_HOST: '0.0.0.0' }), 'http://127.0.0.1:11434', 'a server bind address is not a client URL')
  assert.equal(ollamaHost({ OLLAMA_HOST: '127.0.0.1:11500' }), 'http://127.0.0.1:11500')
  assert.equal(ollamaHost({ OLLAMA_HOST: 'http://gpu-box:11434/' }), 'http://gpu-box:11434')
  assert.equal(ollamaHost({ OLLAMA_HOST: 'https://ollama.example.com' }), 'https://ollama.example.com')
  assert.equal(ollamaHost({ OLLAMA_HOST: 'http://[bad' }), 'http://[bad', 'garbage is passed through, never thrown')
})

test('listOllamaModels reads names and the tools capability, and returns null when Ollama is down', async () => {
  const ok = (async () =>
    new Response(JSON.stringify({ models: [{ name: 'qwq:latest', capabilities: ['completion', 'tools'] }, { name: 'phi3:latest', capabilities: ['completion'] }, { name: 42 }] }))) as unknown as typeof fetch
  assert.deepEqual(await listOllamaModels('http://x', ok), [qwq, phi])

  const down = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
  assert.equal(await listOllamaModels('http://x', down), null)

  const broken = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
  assert.equal(await listOllamaModels('http://x', broken), null)
})

test('resolveDefaultModel: configured, then API key, then a local tools model, then sonnet', async () => {
  const none = async () => null
  const local = async () => [phi, qwq]
  assert.equal(await resolveDefaultModel({ env: { OPENDOTS_DEFAULT_MODEL: 'opus' }, listModels: local }), 'opus')
  assert.equal(await resolveDefaultModel({ env: { OPENDOTS_DEFAULT_MODEL: 'default', ANTHROPIC_API_KEY: 'k' }, listModels: local }), 'sonnet', '"default" cannot name itself')
  assert.equal(await resolveDefaultModel({ env: { ANTHROPIC_API_KEY: 'k' }, listModels: local }), 'sonnet')
  assert.equal(await resolveDefaultModel({ env: {}, listModels: local }), 'ollama/qwq:latest', 'phi3 has no tools, so it is skipped')
  assert.equal(await resolveDefaultModel({ env: {}, listModels: none }), 'sonnet')
})

test('buildModelOptions marks Claude unavailable without a key and lists only tools-capable local models', async () => {
  const built = await buildModelOptions({ env: {}, listModels: async () => [phi, qwq] })
  assert.equal(built.defaultModel, 'ollama/qwq:latest')
  assert.deepEqual(built.ollama, { host: 'http://localhost:11434', reachable: true })
  assert.deepEqual(built.options.map((o) => [o.id, o.available]), [
    ['default', true], ['sonnet', false], ['opus', false], ['haiku', false], ['ollama/qwq:latest', true],
  ])
  assert.equal(built.options[0]?.label, 'Default (ollama/qwq:latest)')

  const withKey = await buildModelOptions({ env: { ANTHROPIC_API_KEY: 'k' }, listModels: async () => null })
  assert.equal(withKey.ollama.reachable, false)
  assert.ok(withKey.options.filter((o) => o.provider === 'anthropic').every((o) => o.available))
})
```

- [ ] **Step 6: Run to see it fail**

Run: `pnpm exec tsx --test src/lib/ai/model-catalog.test.ts`
Expected: FAIL — `Cannot find module './model-catalog'`.

- [ ] **Step 7: Implement `src/lib/ai/model-catalog.ts`**

```ts
import { CLAUDE_MODELS, DEFAULT_MODEL_ID, OLLAMA_PREFIX, type ModelOption } from '../domain/models'

/**
 * What models this server can run right now: Claude when ANTHROPIC_API_KEY is
 * set, plus whatever tools-capable models the local Ollama has pulled. Also
 * decides what the `default` model id means for a turn starting now.
 */

export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434'

/**
 * OLLAMA_HOST is shared with the Ollama server, where it is a bind address
 * ("0.0.0.0", "127.0.0.1:11500"), so a bare host and a wildcard address are
 * turned into a URL a client can call. Never throws: a malformed value is
 * passed through and simply shows up as unreachable.
 */
export function ollamaHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.OLLAMA_HOST ?? '').trim()
  if (!raw) return DEFAULT_OLLAMA_HOST
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`)
    if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1'
    if (!url.port && url.protocol === 'http:') url.port = '11434'
    return url.origin
  } catch {
    return raw
  }
}

export interface OllamaModel {
  name: string
  /** Ollama reports a `tools` capability; every bot turn may call tools. */
  tools: boolean
}

/** Local models, or null when Ollama does not answer. */
export async function listOllamaModels(
  host: string = ollamaHost(),
  fetchFn: typeof fetch = fetch,
  timeoutMs = 1500,
): Promise<OllamaModel[] | null> {
  try {
    const response = await fetchFn(`${host}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return null
    const body = (await response.json()) as { models?: { name?: unknown; capabilities?: unknown }[] }
    return (body.models ?? []).flatMap((model) =>
      typeof model.name === 'string'
        ? [{ name: model.name, tools: Array.isArray(model.capabilities) && model.capabilities.includes('tools') }]
        : [],
    )
  } catch {
    return null
  }
}

export interface CatalogDeps {
  env?: NodeJS.ProcessEnv
  /** Test seam; defaults to asking the configured Ollama. */
  listModels?: () => Promise<OllamaModel[] | null>
}

/** The concrete model a bot set to `default` runs on for a turn starting now. */
export async function resolveDefaultModel(deps: CatalogDeps = {}): Promise<string> {
  const env = deps.env ?? process.env
  const configured = env.OPENDOTS_DEFAULT_MODEL?.trim()
  if (configured && configured !== DEFAULT_MODEL_ID) return configured
  if (env.ANTHROPIC_API_KEY) return 'sonnet'
  const local = await (deps.listModels ?? (() => listOllamaModels(ollamaHost(env))))()
  const pick = local?.find((model) => model.tools)
  return pick ? `${OLLAMA_PREFIX}${pick.name}` : 'sonnet'
}

/** The picker's options, the resolved default, and whether Ollama answered. */
export async function buildModelOptions(deps: CatalogDeps = {}): Promise<{
  options: ModelOption[]
  defaultModel: string
  ollama: { host: string; reachable: boolean }
}> {
  const env = deps.env ?? process.env
  const host = ollamaHost(env)
  // One probe, shared by the default resolution and the list.
  const local = await (deps.listModels ?? (() => listOllamaModels(host)))()
  const defaultModel = await resolveDefaultModel({ env, listModels: async () => local })
  const keySet = Boolean(env.ANTHROPIC_API_KEY)
  const options: ModelOption[] = [
    { id: DEFAULT_MODEL_ID, label: `Default (${defaultModel})`, provider: 'default', available: true },
    ...CLAUDE_MODELS.map((model) => ({ ...model, available: keySet })),
    ...(local ?? [])
      .filter((model) => model.tools)
      .map((model) => ({
        id: `${OLLAMA_PREFIX}${model.name}`,
        label: `${model.name} (local)`,
        provider: 'ollama' as const,
        available: true,
      })),
  ]
  return { options, defaultModel, ollama: { host, reachable: local !== null } }
}
```

- [ ] **Step 8: Run the catalog tests**

Run: `pnpm exec tsx --test src/lib/ai/model-catalog.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 9: Add the route**

`src/app/api/models/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { buildModelOptions } from '@/lib/ai/model-catalog'

/** The model picker's options: Claude (when a key is set) and local Ollama models. */
export async function GET() {
  const { options, defaultModel } = await buildModelOptions()
  return NextResponse.json({ models: options, defaultModel })
}
```

- [ ] **Step 10: Update the assistant config — failing test first**

In `src/lib/domain/assistant.test.ts`, replace the first test with:

```ts
test('parseAssistantConfig fills name and avatar, defaults the model, and drops a legacy provider field', () => {
  const parsed = parseAssistantConfig({ provider: 'claude_code', model: '  ' }, 'Chief of Staff')
  assert.equal('provider' in parsed, false)
  assert.equal(parsed.model, 'default')
  assert.equal(parsed.name, 'Chief of Staff')
  assert.ok(parsed.avatar.shape && parsed.avatar.color)
})

test('the Files tool says it is confined to the workspace', () => {
  const files = TOOL_CATALOG.find((t) => t.id === 'files')
  assert.match(files?.description ?? '', /inside the bot's own workspace/)
})
```

Run: `pnpm exec tsx --test src/lib/domain/assistant.test.ts`
Expected: FAIL — `provider` is still present and the model is `sonnet`.

- [ ] **Step 11: Edit `src/lib/domain/assistant.ts`**

1. Add at the top: `import { DEFAULT_MODEL_ID } from './models'`.
2. Change the `files` entry's `description` to:
   `'Read, write, and search files inside the bot\'s own workspace. Paths outside it are refused.'`
3. Delete the whole block from `/** Claude on the operator's subscription is the only provider. */` through the end of `MODEL_CATALOG` (the `LlmProviderId` type, `ProviderDescriptor`, `PROVIDER_CATALOG`, and `MODEL_CATALOG`).
4. In `AssistantConfig`, delete `provider: LlmProviderId` and change the `model` comment to:
   `/** \`default\`, \`ollama/<name>\`, or an Anthropic API model id (see domain/models.ts). */`
5. In `DEFAULT_ASSISTANT`, delete `provider: 'claude_code',` and set `model: DEFAULT_MODEL_ID,`.
6. Delete the `isProviderId` function.
7. Change the final `return` of `parseAssistantConfig` to:
   `return { model, name, avatar, systemMessage, tools, memory, guardrails, skillIds, browser }`

Existing rows: OpenDots is new, so no stored bot has the old `sonnet` default to migrate. Bots created before this change in a developer's local store keep their explicit model, which is valid.

- [ ] **Step 12: Fix the two other users**

`src/components/NewBotDialog.tsx`:
- In the import from `@/lib/domain/assistant`, remove `MODEL_CATALOG`.
- Add `import { STATIC_MODEL_OPTIONS } from '@/lib/domain/models'`.
- Replace both uses of `MODEL_CATALOG` with `STATIC_MODEL_OPTIONS` (Task 6 replaces this with live options).
- In `handleSubmit`, delete the line `provider: 'claude_code',`.

`src/lib/ai/agents/bot-turn.ts`, in `dryRunAnswer`, replace the first line with:

```ts
    `[dry run] ${bot.name} would answer now, but the brain is in dry-run mode, so no model was called.`,
```

- [ ] **Step 13: Run everything**

Run: `pnpm typecheck && pnpm test && pnpm eval && pnpm lint`
Expected: all exit 0; eval `15 passed, 2 skipped`.

- [ ] **Step 14: Commit**

```bash
git add src/lib/domain/models.ts src/lib/domain/models.test.ts src/lib/ai/model-catalog.ts src/lib/ai/model-catalog.test.ts src/app/api/models/route.ts src/lib/domain/assistant.ts src/lib/domain/assistant.test.ts src/components/NewBotDialog.tsx src/lib/ai/agents/bot-turn.ts
git commit -m "feat: model ids for Claude and Ollama, a live model list, and a resolved default

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The CLI environment per provider, and the workspace guard

**Files:**
- Create: `src/lib/ai/brain-env.ts`, `src/lib/ai/brain-env.test.ts`
- Create: `src/lib/ai/tools/workspace-guard.ts`, `src/lib/ai/tools/workspace-guard.test.ts`

**Interfaces:**
- Consumes: `ResolvedModel` (Task 2, `src/lib/domain/models.ts`), `ollamaHost` (Task 2).
- Produces: `brainEnv(resolved: ResolvedModel, source: NodeJS.ProcessEnv, dataDir: string): Record<string, string>`.
- Produces: `GUARDED_TOOLS`, `OUTSIDE_WORKSPACE` (the denial text), `checkWorkspacePath(tool: string, input: unknown, workspaceDir: string): { ok: true } | { ok: false; reason: string }`, `workspaceGuardHook(workspaceDir: string): HookCallback`.

Trust-list decisions this task implements (spec 5.5): the subprocess env allowlist gains provider variables per provider and loses `CLAUDE_CODE_OAUTH_TOKEN`; the new hook denies file-tool paths outside the workspace; `Bash` is deliberately not guarded.

- [ ] **Step 1: Write the failing env tests**

`src/lib/ai/brain-env.test.ts`:

```ts
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { brainEnv } from './brain-env'

const HOST_ENV = {
  PATH: '/usr/bin',
  HOME: '/home/op',
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://user:pw@host/db',
  DEPLOYMENT_SESSION_SECRET: 'hmac-key',
  CLERK_SECRET_KEY: 'sk_test_x',
  CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token',
  ANTHROPIC_API_KEY: 'sk-ant-operator',
}

test('an Anthropic run gets the API key and nothing it should not', () => {
  const env = brainEnv({ provider: 'anthropic', sdkModel: 'sonnet' }, HOST_ENV, '/data')
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-operator')
  assert.equal(env.ANTHROPIC_BASE_URL, undefined, 'no base URL unless the operator set one')
  assert.equal(env.CLAUDE_CONFIG_DIR, join('/data', 'claude'))
  assert.equal(env.NO_COLOR, '1')
  for (const secret of ['CLAUDE_CODE_OAUTH_TOKEN', 'DATABASE_URL', 'DEPLOYMENT_SESSION_SECRET', 'CLERK_SECRET_KEY', 'NODE_ENV']) {
    assert.equal(env[secret], undefined, `${secret} must not reach the CLI`)
  }
  const compat = brainEnv({ provider: 'anthropic', sdkModel: 'x' }, { ...HOST_ENV, ANTHROPIC_BASE_URL: 'https://proxy.example' }, '/data')
  assert.equal(compat.ANTHROPIC_BASE_URL, 'https://proxy.example')
})

test('an Ollama run points the CLI at Ollama and never carries the operator key', () => {
  const env = brainEnv({ provider: 'ollama', sdkModel: 'qwq:latest' }, { ...HOST_ENV, OLLAMA_HOST: '0.0.0.0' }, '/data')
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11434')
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'ollama')
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'qwq:latest')
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'qwq:latest')
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'qwq:latest')
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1')
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
  assert.equal(env.PATH, '/usr/bin')
})
```

Run: `pnpm exec tsx --test src/lib/ai/brain-env.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement `src/lib/ai/brain-env.ts`**

```ts
import { join } from 'node:path'
import type { ResolvedModel } from '../domain/models'
import { ollamaHost } from './model-catalog'

/** Kept because a CLI subprocess without them cannot find node, npx, or a home. */
const BASE_ALLOWLIST = ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'SHELL'] as const

/**
 * The environment the Agent SDK's CLI subprocess runs with, built from an
 * allowlist. The SDK replaces the subprocess environment outright when `env`
 * is given, so anything not added here (DATABASE_URL, the share-link secret,
 * Clerk keys) never reaches a bot — including a bot that has `shell`.
 *
 * CLAUDE_CONFIG_DIR is always OpenDots' own directory: bots never read the
 * operator's ~/.claude (settings, memory, login) and their sessions never
 * land there. There is deliberately no path to a claude.ai subscription login.
 */
export function brainEnv(
  resolved: ResolvedModel,
  source: NodeJS.ProcessEnv,
  dataDir: string,
): Record<string, string> {
  const env: Record<string, string> = { NO_COLOR: '1', CLAUDE_CONFIG_DIR: join(dataDir, 'claude') }
  for (const key of BASE_ALLOWLIST) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) env[key] = value
  }

  if (resolved.provider === 'anthropic') {
    if (source.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = source.ANTHROPIC_API_KEY
    // OpenRouter, a LiteLLM proxy, or any other Anthropic-compatible endpoint.
    if (source.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = source.ANTHROPIC_BASE_URL
    return env
  }

  // Ollama speaks the Anthropic Messages API, so the same CLI runs against it.
  env.ANTHROPIC_BASE_URL = ollamaHost(source)
  env.ANTHROPIC_AUTH_TOKEN = 'ollama'
  // The CLI makes background calls on its "small" model; keep those local too.
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = resolved.sdkModel
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = resolved.sdkModel
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = resolved.sdkModel
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  return env
}
```

Run: `pnpm exec tsx --test src/lib/ai/brain-env.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 3: Write the failing guard tests (real paths, real symlinks)**

`src/lib/ai/tools/workspace-guard.test.ts`:

```ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { OUTSIDE_WORKSPACE, checkWorkspacePath, workspaceGuardHook } from './workspace-guard'

/** A real workspace under the OS temp dir. On macOS that path itself runs through the /var -> /private/var symlink. */
function workspace(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'opendots-guard-'))
  const ws = join(root, 'ws')
  mkdirSync(join(ws, 'notes'), { recursive: true })
  writeFileSync(join(ws, 'notes', 'a.md'), 'hello')
  writeFileSync(join(root, 'secret.txt'), 'outside')
  symlinkSync(root, join(ws, 'escape'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return ws
}

const allowed = { ok: true }
const denied = { ok: false, reason: OUTSIDE_WORKSPACE }

test('paths inside the workspace are allowed, including files that do not exist yet', (t) => {
  const ws = workspace(t)
  assert.deepEqual(checkWorkspacePath('Read', { file_path: 'notes/a.md' }, ws), allowed)
  assert.deepEqual(checkWorkspacePath('Read', { file_path: join(ws, 'notes', 'a.md') }, ws), allowed)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: join(ws, 'new', 'deep', 'b.md') }, ws), allowed)
  assert.deepEqual(checkWorkspacePath('Edit', { file_path: 'notes/a.md' }, ws), allowed)
  assert.deepEqual(checkWorkspacePath('Grep', { pattern: 'TODO' }, ws), allowed)
  assert.deepEqual(checkWorkspacePath('Glob', { pattern: '**/*.md' }, ws), allowed)
  assert.deepEqual(checkWorkspacePath('Glob', { pattern: 'notes/*.md', path: 'notes' }, ws), allowed)
})

test('paths that leave the workspace are denied', (t) => {
  const ws = workspace(t)
  assert.deepEqual(checkWorkspacePath('Read', { file_path: '../secret.txt' }, ws), denied)
  assert.deepEqual(checkWorkspacePath('Read', { file_path: '/etc/hosts' }, ws), denied)
  assert.deepEqual(checkWorkspacePath('Read', { file_path: '~/.ssh/id_rsa' }, ws), denied)
  assert.deepEqual(checkWorkspacePath('Read', { file_path: join(homedir(), '.ssh', 'id_rsa') }, ws), denied)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: '/tmp/x' }, ws), denied)
  assert.deepEqual(checkWorkspacePath('NotebookEdit', { notebook_path: '/tmp/n.ipynb' }, ws), denied)
  assert.deepEqual(checkWorkspacePath('Grep', { pattern: 'key', path: '/' }, ws), denied)
})

test('a symlink inside the workspace cannot be used to step out of it', (t) => {
  const ws = workspace(t)
  assert.deepEqual(checkWorkspacePath('Read', { file_path: 'escape/secret.txt' }, ws), denied)
  assert.deepEqual(checkWorkspacePath('Write', { file_path: 'escape/new.txt' }, ws), denied)
})

test('glob patterns are judged by where they can reach', (t) => {
  const ws = workspace(t)
  assert.deepEqual(checkWorkspacePath('Glob', { pattern: '/etc/**' }, ws), denied)
  assert.deepEqual(checkWorkspacePath('Glob', { pattern: '/**' }, ws), denied)
  assert.deepEqual(checkWorkspacePath('Glob', { pattern: '../*' }, ws), denied)
  assert.deepEqual(checkWorkspacePath('Glob', { pattern: 'notes/**/../../../*' }, ws), denied, '".." after a wildcard is refused outright')
  assert.deepEqual(checkWorkspacePath('Glob', { pattern: '~/**' }, ws), denied)
})

test('tools the guard does not cover pass through', (t) => {
  const ws = workspace(t)
  assert.deepEqual(checkWorkspacePath('Bash', { command: 'cat /etc/hosts' }, ws), allowed)
  assert.deepEqual(checkWorkspacePath('mcp__opendots__search_knowledge', { query: '/etc' }, ws), allowed)
})

test('the hook denies with the reason, allows silently, and fails closed', async (t) => {
  const ws = workspace(t)
  const hook = workspaceGuardHook(ws)
  const signal = new AbortController().signal
  const base = { session_id: 's', transcript_path: '/t', cwd: ws, hook_event_name: 'PreToolUse' as const, tool_use_id: 'u1' }

  assert.deepEqual(await hook({ ...base, tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } }, 'u1', { signal }), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: OUTSIDE_WORKSPACE },
  })
  assert.deepEqual(await hook({ ...base, tool_name: 'Read', tool_input: { file_path: 'notes/a.md' } }, 'u1', { signal }), {})

  const gone = workspaceGuardHook(join(ws, 'does-not-exist'))
  const verdict = await gone({ ...base, tool_name: 'Read', tool_input: { file_path: 'a.md' } }, 'u1', { signal })
  assert.equal((verdict as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, 'deny')
})
```

Run: `pnpm exec tsx --test src/lib/ai/tools/workspace-guard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/lib/ai/tools/workspace-guard.ts`**

```ts
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk'

/**
 * Keeps a bot's file tools inside its own workspace.
 *
 * This has to be a PreToolUse hook: tools named in `allowedTools` are
 * approved before `canUseTool` is ever consulted, so a path check there would
 * silently never run for a granted tool. Hooks run first, on every call.
 *
 * Bash is deliberately not covered: a shell can reach anything the server
 * user can, which is why `shell` is off by default and documented as host access.
 */

export const GUARDED_TOOLS = ['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep'] as const
export const OUTSIDE_WORKSPACE = 'Bots can only use files inside their own workspace.'

const GLOB_CHARS = /[*?[\]{}]/

/** The file tools expand a leading `~`, so the guard must judge it as the home directory. */
function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
}

/** realpath of the nearest existing ancestor with the missing tail re-attached, so new files resolve too. */
function realpathNearest(path: string): string {
  let current = path
  const tail: string[] = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    tail.unshift(basename(current))
    current = parent
  }
  return join(realpathSync(current), ...tail)
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** The fixed directory a glob starts from, and whether it climbs with ".." after a wildcard. */
function splitGlob(pattern: string): { prefix: string; climbsAfterWildcard: boolean } {
  const segments = pattern.split('/')
  const firstWild = segments.findIndex((segment) => GLOB_CHARS.test(segment))
  const fixed = firstWild === -1 ? segments : segments.slice(0, firstWild)
  const rest = firstWild === -1 ? [] : segments.slice(firstWild)
  let prefix = fixed.join('/')
  if (pattern.startsWith('/') && prefix === '') prefix = '/'
  return { prefix, climbsAfterWildcard: rest.includes('..') }
}

export function checkWorkspacePath(
  tool: string,
  input: unknown,
  workspaceDir: string,
): { ok: true } | { ok: false; reason: string } {
  if (!(GUARDED_TOOLS as readonly string[]).includes(tool)) return { ok: true }
  const denied = { ok: false as const, reason: OUTSIDE_WORKSPACE }
  const record = (input ?? {}) as Record<string, unknown>
  const root = realpathSync(workspaceDir)
  const at = (value: string, base: string = root) => resolve(base, expandHome(value))

  const candidates: string[] = []
  for (const key of ['file_path', 'notebook_path', 'path'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) candidates.push(at(value))
  }
  if (tool === 'Glob' && typeof record.pattern === 'string') {
    const { prefix, climbsAfterWildcard } = splitGlob(record.pattern)
    if (climbsAfterWildcard) return denied
    const base = typeof record.path === 'string' && record.path.length > 0 ? at(record.path) : root
    candidates.push(at(prefix, base))
  }

  for (const candidate of candidates) {
    if (!isInside(root, realpathNearest(candidate))) return denied
  }
  return { ok: true }
}

/** The PreToolUse hook `runBot` installs on every run. Any error denies: a guard that throws must not open the door. */
export function workspaceGuardHook(workspaceDir: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    let verdict: ReturnType<typeof checkWorkspacePath>
    try {
      verdict = checkWorkspacePath(input.tool_name, input.tool_input, workspaceDir)
    } catch {
      verdict = { ok: false, reason: OUTSIDE_WORKSPACE }
    }
    if (verdict.ok) return {}
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: verdict.reason,
      },
    }
  }
}
```

- [ ] **Step 5: Run the guard tests**

Run: `pnpm exec tsx --test src/lib/ai/tools/workspace-guard.test.ts`
Expected: PASS (6 tests). If the hook test fails to type-check against `HookInput`, cast the test inputs with `as Parameters<typeof hook>[0]` — do not loosen the hook's own types.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: exit 0.

```bash
git add src/lib/ai/brain-env.ts src/lib/ai/brain-env.test.ts src/lib/ai/tools/workspace-guard.ts src/lib/ai/tools/workspace-guard.test.ts
git commit -m "feat: per-provider CLI environment and a workspace guard for file tools

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 4: The brain runs on Anthropic or Ollama

**Files:**
- Rename: `src/lib/ai/claude-code.ts` → `src/lib/ai/brain.ts`; `src/lib/ai/claude-code.test.ts` → `src/lib/ai/brain.test.ts`
- Modify: `src/lib/ai/brain.ts` (top section and `runBot`)
- Rewrite: `src/lib/ai/brain.test.ts`
- Rewrite: `src/lib/ai/config.ts`
- Modify: `src/lib/ai/agents/run-bot-turn.ts` (imports, deps, model resolution, trace, error copy)
- Modify: `src/lib/ai/agents/run-bot-turn.test.ts` (import path, default-model pin, one new test)
- Rewrite: `src/app/api/health/route.ts`
- Modify: `src/hooks/useChat.ts:299-303` (error copy)
- Modify comments: `src/lib/ai/respond-stream.ts:33`, `scripts/run-evals.ts:10`

**Interfaces:**
- Consumes: `resolveModel`, `ResolvedModel`, `DEFAULT_MODEL_ID`, `OLLAMA_PREFIX` (Task 2); `ollamaHost`, `resolveDefaultModel`, `buildModelOptions` (Task 2); `brainEnv` (Task 3); `workspaceGuardHook` (Task 3); `dataDir` (Task 1).
- Produces (`brain.ts`): `runBot(input: BotRunInput, deps?: { query?: QueryFn; env?: NodeJS.ProcessEnv })`; `BotEvent` result `costUsd: number | null`; `MISSING_API_KEY: string`; `interface BrainStatus { mode: 'live' | 'dry-run'; anthropic: { keySet: boolean; customBaseUrl: boolean }; ollama: { host: string } }`; `describeBrain(env?): BrainStatus`; `explainOllamaFailure(message: string, resolved: ResolvedModel, host: string): string`. `scrubbedEnv` is deleted (replaced by `brainEnv`; its only importer is the old test file).
- Produces (`run-bot-turn.ts`): `runBotTurn` deps gain `resolveDefaultModel?: () => Promise<string>`.

- [ ] **Step 1: Rename with history**

```bash
git mv src/lib/ai/claude-code.ts src/lib/ai/brain.ts
git mv src/lib/ai/claude-code.test.ts src/lib/ai/brain.test.ts
grep -rln "claude-code'" src scripts
```

Expected: the grep lists `src/lib/ai/config.ts`, `src/lib/ai/agents/run-bot-turn.ts`, `src/lib/ai/agents/run-bot-turn.test.ts`, `src/lib/ai/brain.test.ts`. Each is fixed in the steps below.

- [ ] **Step 2: Write the new brain tests (they fail until Step 4)**

Replace the whole of `src/lib/ai/brain.test.ts` with:

```ts
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { HookCallbackMatcher, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  MISSING_API_KEY,
  classifyError,
  describeBrain,
  explainOllamaFailure,
  mapSdkMessage,
  runBot,
  type BotEvent,
  type BotRunInput,
  type QueryFn,
} from './brain'
import { OUTSIDE_WORKSPACE } from './tools/workspace-guard'

/** A throwaway data dir per test, so no run writes under ./.opendots. */
function testEnv(t: TestContext, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-brain-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { PATH: process.env.PATH, HOME: process.env.HOME, OPENDOTS_DATA_DIR: dir, ...extra }
}

const BASE: BotRunInput = {
  model: 'sonnet',
  systemPrompt: '',
  prompt: 'x',
  sessionId: null,
  workspaceDir: tmpdir(),
  builtinTools: [],
  allowedTools: [],
  maxTurns: 1,
}

/** A fake SDK query(): records the options it was given and replays scripted messages. */
function recordingQuery(messages: unknown[]) {
  let options: Record<string, unknown> | undefined
  let calls = 0
  const fn = ((args: { prompt: string; options?: Record<string, unknown> }) => {
    calls += 1
    options = args.options
    return (async function* () {
      for (const message of messages) yield message
    })()
  }) as unknown as QueryFn
  return { fn, options: () => options, calls: () => calls }
}

async function collect(events: AsyncGenerator<BotEvent>): Promise<BotEvent[]> {
  const out: BotEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

test('describeBrain reports dry-run, whether a key is set, and the Ollama host', () => {
  assert.deepEqual(describeBrain({ BRAIN_DRY_RUN: '1' }), {
    mode: 'dry-run',
    anthropic: { keySet: false, customBaseUrl: false },
    ollama: { host: 'http://localhost:11434' },
  })
  const live = describeBrain({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://proxy', OLLAMA_HOST: 'gpu:11434' })
  assert.equal(live.mode, 'live')
  assert.deepEqual(live.anthropic, { keySet: true, customBaseUrl: true })
  assert.equal(live.ollama.host, 'http://gpu:11434')
})

test('classifyError maps provider failures to UI kinds', () => {
  assert.equal(classifyError('429 rate limit exceeded'), 'usage_limit')
  assert.equal(classifyError('You have exceeded your usage limit for this period'), 'usage_limit')
  assert.equal(classifyError('Invalid API key'), 'auth')
  assert.equal(classifyError('No conversation found with session ID abc'), 'session_not_found')
  assert.equal(classifyError('something else'), 'other')
})

test('mapSdkMessage turns SDK messages into bot events', () => {
  const pending = new Map<string, string>()
  const events = [
    { type: 'system', subtype: 'init', session_id: 's1' },
    { type: 'stream_event', session_id: 's1', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } } },
    { type: 'assistant', session_id: 's1', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__opendots__search_knowledge', input: { query: 'rollback' } }] } },
    { type: 'user', session_id: 's1', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '2 passages' }], is_error: false }] } },
    { type: 'result', subtype: 'success', session_id: 's1', result: 'Hello', total_cost_usd: 0.01, num_turns: 2 },
    { type: 'result', subtype: 'error_during_execution', session_id: 's1', errors: ['rate limit'] },
  ].flatMap((m) => mapSdkMessage(m as unknown as SDKMessage, pending))

  assert.deepEqual(events[0], { type: 'session', sessionId: 's1' })
  assert.deepEqual(events[1], { type: 'text', delta: 'Hel' })
  assert.ok(events[2]?.type === 'tool_start' && events[2].summary.includes('rollback'))
  assert.deepEqual(events[3], { type: 'tool_result', name: 'mcp__opendots__search_knowledge', ok: true, summary: '2 passages' })
  assert.deepEqual(events[4], { type: 'result', text: 'Hello', sessionId: 's1', costUsd: 0.01, turns: 2 })
  assert.deepEqual(events[5], { type: 'error', message: 'rate limit', kind: 'usage_limit' })
})

test('runBot passes workspace, resume id, grants, a scrubbed env and the guard hook to query()', async (t) => {
  const env = testEnv(t, { ANTHROPIC_API_KEY: 'sk-ant-test', DATABASE_URL: 'postgres://user:pw@host/db' })
  const q = recordingQuery([
    { type: 'system', subtype: 'init', session_id: 's9' },
    { type: 'result', subtype: 'success', session_id: 's9', result: 'ok', total_cost_usd: 0.002, num_turns: 1 },
  ])
  const events = await collect(runBot(
    {
      ...BASE, systemPrompt: 'be brief', prompt: 'hi', sessionId: 'old', workspaceDir: '/tmp/ws',
      builtinTools: ['Read'], allowedTools: ['Read', 'mcp__opendots__search_knowledge'], maxTurns: 3,
    },
    { query: q.fn, env },
  ))

  const options = q.options()!
  assert.equal(options.model, 'sonnet')
  assert.equal(options.cwd, '/tmp/ws')
  assert.equal(options.resume, 'old')
  assert.deepEqual(options.tools, ['Read'])
  assert.deepEqual(options.allowedTools, ['Read', 'mcp__opendots__search_knowledge'])
  assert.equal(options.maxTurns, 3)
  assert.equal(options.permissionMode, 'default')
  assert.equal(options.includePartialMessages, true)
  const subEnv = options.env as Record<string, string>
  assert.equal(subEnv.DATABASE_URL, undefined, 'the CLI subprocess must not inherit this server\'s secrets')
  assert.equal(subEnv.ANTHROPIC_API_KEY, 'sk-ant-test')
  assert.equal(subEnv.CLAUDE_CONFIG_DIR, join(env.OPENDOTS_DATA_DIR!, 'claude'))
  assert.equal((options.hooks as { PreToolUse?: HookCallbackMatcher[] }).PreToolUse?.length, 1)
  const canUseTool = options.canUseTool as (name: string, input: unknown, o: unknown) => Promise<{ behavior: string }>
  assert.equal((await canUseTool('Read', {}, {})).behavior, 'allow')
  assert.equal((await canUseTool('Bash', {}, {})).behavior, 'deny')
  assert.deepEqual(events.map((e) => e.type), ['session', 'result'])
  assert.equal(events[1]?.type === 'result' && events[1].costUsd, 0.002)
})

test('the installed hook refuses a path outside the workspace', async (t) => {
  const env = testEnv(t, { ANTHROPIC_API_KEY: 'k' })
  const ws = mkdtempSync(join(tmpdir(), 'opendots-brain-ws-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }))
  const q = recordingQuery([])
  await collect(runBot({ ...BASE, workspaceDir: ws }, { query: q.fn, env }))

  const [matcher] = (q.options()!.hooks as { PreToolUse: HookCallbackMatcher[] }).PreToolUse
  const out = await matcher!.hooks[0]!(
    { session_id: 's', transcript_path: '/t', cwd: ws, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/etc/hosts' }, tool_use_id: 'u' },
    'u',
    { signal: new AbortController().signal },
  )
  assert.equal(
    (out as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason,
    OUTSIDE_WORKSPACE,
  )
})

test('an Anthropic model without ANTHROPIC_API_KEY fails before the CLI is spawned', async (t) => {
  const q = recordingQuery([])
  const events = await collect(runBot(BASE, { query: q.fn, env: testEnv(t) }))
  assert.deepEqual(events, [{ type: 'error', message: MISSING_API_KEY, kind: 'auth' }])
  assert.equal(q.calls(), 0, 'there is no fallback to a claude.ai login')
})

test('the default model id must be resolved before runBot is called', async (t) => {
  const q = recordingQuery([])
  const events = await collect(runBot({ ...BASE, model: 'default' }, { query: q.fn, env: testEnv(t, { ANTHROPIC_API_KEY: 'k' }) }))
  assert.equal(events[0]?.type, 'error')
  assert.equal(q.calls(), 0)
})

test('an Ollama model runs against Ollama, without the operator key and without a dollar cost', async (t) => {
  const env = testEnv(t, { ANTHROPIC_API_KEY: 'sk-ant-operator', OLLAMA_HOST: 'http://127.0.0.1:11434' })
  const q = recordingQuery([{ type: 'result', subtype: 'success', session_id: 's', result: 'hi', total_cost_usd: 0.42, num_turns: 2 }])
  const events = await collect(runBot({ ...BASE, model: 'ollama/qwq:latest' }, { query: q.fn, env }))

  const options = q.options()!
  assert.equal(options.model, 'qwq:latest')
  const subEnv = options.env as Record<string, string>
  assert.equal(subEnv.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11434')
  assert.equal(subEnv.ANTHROPIC_API_KEY, undefined)
  assert.deepEqual(events, [{ type: 'result', text: 'hi', sessionId: 's', costUsd: null, turns: 2 }])
})

test('Ollama connection and missing-model failures say what to do', async (t) => {
  const env = testEnv(t, { OLLAMA_HOST: 'http://127.0.0.1:11434' })
  const refused = (() => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434') }) as unknown as QueryFn
  const [down] = await collect(runBot({ ...BASE, model: 'ollama/qwq:latest' }, { query: refused, env }))
  assert.equal(down?.type === 'error' && down.message, "Ollama isn't answering at http://127.0.0.1:11434. Start it with `ollama serve`.")

  const qwq = { provider: 'ollama' as const, sdkModel: 'qwq:latest' }
  assert.equal(
    explainOllamaFailure('model "qwq:latest" not found, try pulling it first', qwq, 'http://h'),
    "qwq:latest isn't pulled. Run `ollama pull qwq:latest`.",
  )
  assert.equal(explainOllamaFailure('something else', qwq, 'http://h'), 'something else')
})

test('runBot turns a thrown spawn error into an error event', async (t) => {
  const throwing = (() => { throw new Error('spawn failed: invalid api key') }) as unknown as QueryFn
  const events = await collect(runBot(BASE, { query: throwing, env: testEnv(t, { ANTHROPIC_API_KEY: 'k' }) }))
  assert.equal(events[0]?.type === 'error' && events[0].kind, 'auth')
})

test('runBot aborts the SDK run when the consumer stops reading', async (t) => {
  let drained = 0
  let options: Record<string, unknown> | undefined
  const fakeQuery = ((args: { prompt: string; options?: Record<string, unknown> }) => {
    options = args.options
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1' }
      drained += 1
      yield { type: 'result', subtype: 'success', session_id: 's1', result: 'late', total_cost_usd: 0, num_turns: 1 }
      drained += 1
    })()
  }) as unknown as QueryFn

  for await (const event of runBot(BASE, { query: fakeQuery, env: testEnv(t, { ANTHROPIC_API_KEY: 'k' }) })) {
    assert.equal(event.type, 'session')
    break
  }

  assert.equal((options?.abortController as AbortController).signal.aborted, true, 'closing the generator must abort the CLI subprocess')
  assert.equal(drained, 0, 'the SDK stream must not be advanced after the consumer left')
})
```

Run: `pnpm exec tsx --test src/lib/ai/brain.test.ts`
Expected: FAIL (missing exports such as `MISSING_API_KEY`, `explainOllamaFailure`).

- [ ] **Step 3: Rewrite the top of `src/lib/ai/brain.ts`**

Replace everything from the first line down to (not including) `export function classifyError` with:

```ts
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  query as sdkQuery,
  type McpServerConfig,
  type Options,
  type PermissionResult,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { dataDir } from '../data-dir'
import { resolveModel, type ResolvedModel } from '../domain/models'
import { brainEnv } from './brain-env'
import { ollamaHost } from './model-catalog'
import { workspaceGuardHook } from './tools/workspace-guard'

/**
 * The brain: one Agent SDK run per bot turn, on Claude through the Anthropic
 * API or on a local model through Ollama's Anthropic-compatible endpoint.
 *
 * The model id decides the provider (domain/models.ts) and brain-env.ts
 * decides what the CLI subprocess may see. This module knows nothing about
 * channels or storage: it turns one prompt into a stream of BotEvents.
 */

export type BotErrorKind = 'usage_limit' | 'auth' | 'aborted' | 'session_not_found' | 'other'

export type BotEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; name: string; summary: string }
  | { type: 'tool_result'; name: string; ok: boolean; summary: string }
  | { type: 'session'; sessionId: string }
  /** `costUsd` is null for local models: the CLI cannot price a model it does not know. */
  | { type: 'result'; text: string; sessionId: string; costUsd: number | null; turns: number }
  | { type: 'error'; message: string; kind: BotErrorKind }

export interface BotRunInput {
  /** A concrete model id. `default` is resolved by the caller (run-bot-turn.ts). */
  model: string
  systemPrompt: string
  prompt: string
  /** Resume this SDK session when set; a fresh session otherwise. */
  sessionId: string | null
  /** The bot's working directory. Skills under `.claude/skills/` load from here. */
  workspaceDir: string
  /** Built-in tools that exist for this run (Read, Bash, ...). */
  builtinTools: string[]
  /** Everything auto-approved: built-ins plus `mcp__opendots__*` names. */
  allowedTools: string[]
  mcpServers?: Record<string, McpServerConfig>
  maxTurns: number
  maxBudgetUsd?: number
  signal?: AbortSignal
}

export const MISSING_API_KEY = 'Set ANTHROPIC_API_KEY, or switch this bot to an Ollama model.'

export interface BrainStatus {
  mode: 'live' | 'dry-run'
  anthropic: { keySet: boolean; customBaseUrl: boolean }
  ollama: { host: string }
}

export function describeBrain(env: NodeJS.ProcessEnv = process.env): BrainStatus {
  return {
    mode: env.BRAIN_DRY_RUN === '1' ? 'dry-run' : 'live',
    anthropic: { keySet: Boolean(env.ANTHROPIC_API_KEY), customBaseUrl: Boolean(env.ANTHROPIC_BASE_URL) },
    ollama: { host: ollamaHost(env) },
  }
}

/** Ollama failures surface as generic connection or not-found text; say what to do instead. */
export function explainOllamaFailure(message: string, resolved: ResolvedModel, host: string): string {
  if (/ECONNREFUSED|fetch failed|connection error|socket hang up|connect/i.test(message)) {
    return `Ollama isn't answering at ${host}. Start it with \`ollama serve\`.`
  }
  if (/not found|\b404\b/i.test(message)) {
    return `${resolved.sdkModel} isn't pulled. Run \`ollama pull ${resolved.sdkModel}\`.`
  }
  return message
}

```

Keep `classifyError`, `SUMMARY_MAX`, `summarizeToolInput`, `textOf`, `mapSdkMessage` and `export type QueryFn = typeof sdkQuery` exactly as they are.

- [ ] **Step 4: Replace `runBot`**

Replace the whole `export async function* runBot(...) { ... }` with:

```ts
export async function* runBot(
  input: BotRunInput,
  deps: { query?: QueryFn; env?: NodeJS.ProcessEnv } = {},
): AsyncGenerator<BotEvent> {
  const query = deps.query ?? sdkQuery
  const source = deps.env ?? process.env

  let resolved: ResolvedModel
  try {
    resolved = resolveModel(input.model)
  } catch (cause) {
    yield { type: 'error', message: cause instanceof Error ? cause.message : String(cause), kind: 'other' }
    return
  }
  // No fallback to a claude.ai login: without a key an Anthropic model cannot run.
  if (resolved.provider === 'anthropic' && !source.ANTHROPIC_API_KEY) {
    yield { type: 'error', message: MISSING_API_KEY, kind: 'auth' }
    return
  }

  const root = dataDir(source)
  mkdirSync(join(root, 'claude'), { recursive: true })
  const host = ollamaHost(source)
  const explain = (event: BotEvent): BotEvent =>
    event.type === 'error' && event.kind === 'other' && resolved.provider === 'ollama'
      ? { ...event, message: explainOllamaFailure(event.message, resolved, host) }
      : event

  const abortController = new AbortController()
  input.signal?.addEventListener('abort', () => abortController.abort(), { once: true })
  let stderrTail = ''

  const canUseTool = async (toolName: string): Promise<PermissionResult> =>
    input.allowedTools.includes(toolName)
      ? { behavior: 'allow' }
      : {
          behavior: 'deny',
          message: `Tool "${toolName}" is not granted to this bot. Continue without it, or tell the user which tool you need.`,
        }

  const options: Options = {
    model: resolved.sdkModel,
    systemPrompt: input.systemPrompt,
    cwd: input.workspaceDir,
    // Replaces the subprocess environment outright — the SDK does not merge it.
    env: brainEnv(resolved, source, root),
    resume: input.sessionId ?? undefined,
    persistSession: true,
    // Loads <workspace>/.claude/* — settings and installed skills.
    settingSources: ['project'],
    tools: input.builtinTools,
    allowedTools: input.allowedTools,
    permissionMode: 'default',
    canUseTool,
    // Hooks run before allow rules, so this also covers tools in allowedTools,
    // which never reach canUseTool.
    hooks: { PreToolUse: [{ hooks: [workspaceGuardHook(input.workspaceDir)] }] },
    mcpServers: input.mcpServers,
    includePartialMessages: true,
    maxTurns: input.maxTurns,
    ...(input.maxBudgetUsd ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
    abortController,
    stderr: (data) => {
      stderrTail = (stderrTail + data).slice(-2000)
    },
  }

  const pendingTools = new Map<string, string>()
  try {
    for await (const message of query({ prompt: input.prompt, options })) {
      for (const event of mapSdkMessage(message, pendingTools)) {
        yield event.type === 'result' && resolved.provider === 'ollama' ? { ...event, costUsd: null } : explain(event)
      }
    }
  } catch (cause) {
    const text = cause instanceof Error ? cause.message : String(cause)
    const detail = [text, stderrTail.trim()].filter(Boolean).join('\n')
    yield explain({
      type: 'error',
      message: detail,
      kind: input.signal?.aborted ? 'aborted' : classifyError(detail),
    })
  } finally {
    // Runs on the normal path AND when a consumer closes the generator early
    // (a disconnected client). Without it the CLI subprocess would keep working
    // — and keep spending API usage — for a reply nobody will read.
    abortController.abort()
  }
}
```

Run: `pnpm exec tsx --test src/lib/ai/brain.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Rewrite `src/lib/ai/config.ts`**

Replace the import line and the brain parts so the file reads:

```ts
import { describeBrain, type BrainStatus } from './brain'

/**
 * Env-driven configuration for the brain and knowledge search. Nothing here
 * touches the network at import time, so it is safe during `next build`.
 * Which model a bot runs on is per bot (domain/models.ts, ai/model-catalog.ts).
 */

export type VectorStoreKind = 'memory' | 'pgvector'

export interface BrainConfig {
  /** Cap on tool-use rounds per turn. */
  maxTurns: number
  /** Optional spend ceiling per turn; null means none. */
  maxBudgetUsd: number | null
  /** True forces the planner's dry-run answer; the eval sets it. */
  dryRun: boolean
}
```

Keep `RagConfig`, `AiConfig`, `env`, `envInt`, `envFloat`, `envBool` unchanged. In `getAiConfig`, the `brain` object becomes:

```ts
    brain: {
      maxTurns: envInt('BOT_MAX_TURNS', 12),
      maxBudgetUsd: budget > 0 ? budget : null,
      dryRun: describeBrain().mode === 'dry-run',
    },
```

And `describeAiConfig` becomes:

```ts
/** Non-secret view for the health endpoint and the UI. */
export function describeAiConfig(config: AiConfig = getAiConfig()): {
  brain: BrainStatus & { maxTurns: number }
  rag: { enabled: boolean; vectorStore: VectorStoreKind; topK: number }
} {
  return {
    brain: { ...describeBrain(), maxTurns: config.brain.maxTurns },
    rag: { enabled: config.rag.enabled, vectorStore: config.rag.vectorStore, topK: config.rag.topK },
  }
}
```

- [ ] **Step 6: Update the turn runner — failing test first**

In `src/lib/ai/agents/run-bot-turn.test.ts`:
1. Change `import type { BotEvent, BotRunInput, runBot } from '../claude-code'` to `import type { BotEvent, BotRunInput, runBot } from '../brain'`.
2. Add `import { DEFAULT_ASSISTANT } from '../../domain/assistant'`.
3. Directly below the imports add:

```ts
// Seeded bots use the `default` model id. Pin what it resolves to so no test
// in this file ever probes a real Ollama.
process.env.OPENDOTS_DEFAULT_MODEL = 'sonnet'
```

4. Append:

```ts
test('a bot on the default model runs on whatever the server resolves, and a local run is traced as local', async (t) => {
  setEnv(t, 'BRAIN_DRY_RUN', undefined)
  useTempWorkspaces(t)
  const created = await memoryRepository.createChannel({
    name: 'Default Model Bot',
    assistant: { ...DEFAULT_ASSISTANT, name: 'Default Model Bot' },
  })
  assert.equal(created.assistant?.model, 'default')
  await memoryRepository.sendMessage(created.channelUrl, 'which model are you?')

  const brain = fakeBrain([[{ type: 'result', text: 'a local one', sessionId: 's-local', costUsd: null, turns: 1 }]])
  const events = await collect(runBotTurn(
    await loadTurnContext(created.channelUrl),
    {},
    { runBot: brain.fn, resolveDefaultModel: async () => 'ollama/qwq:latest' },
  ))

  assert.equal(brain.calls[0]?.model, 'ollama/qwq:latest')
  const trace = events.find((event) => event.type === 'trace')
  assert.ok(trace?.type === 'trace')
  assert.ok(trace.trace.some((entry) => entry.detail === 'default model resolved to ollama/qwq:latest'))
  assert.ok(trace.trace.some((entry) => entry.detail === 'completed in 1 turn(s), local'))
})
```

Run: `pnpm exec tsx --test src/lib/ai/agents/run-bot-turn.test.ts`
Expected: FAIL — the brain is called with `default`.

- [ ] **Step 7: Edit `src/lib/ai/agents/run-bot-turn.ts`**

1. Replace `import { runBot, type BotErrorKind } from '../claude-code'` with:

```ts
import { DEFAULT_MODEL_ID } from '../../domain/models'
import { MISSING_API_KEY, runBot, type BotErrorKind } from '../brain'
import { resolveDefaultModel } from '../model-catalog'
```

2. In the `deps` parameter type of `runBotTurn`, add after `onBrowserHook`:

```ts
    /** Resolves the `default` model id; tests pin it instead of probing Ollama. */
    resolveDefaultModel?: () => Promise<string>
```

3. In the live branch, directly after `const workspaceDir = workspaceFor(channelUrl)`, add:

```ts
      const model =
        assistant.model === DEFAULT_MODEL_ID
          ? await (deps.resolveDefaultModel ?? resolveDefaultModel)()
          : assistant.model
      if (model !== assistant.model) trace.push({ node: plan.route, detail: `default model resolved to ${model}` })
```

4. In the `run({...})` call, change `model: assistant.model,` to `model,`.

5. Replace the trace line in `case 'result':` with:

```ts
              trace.push({
                node: plan.route,
                detail: `completed in ${event.turns} turn(s), ${event.costUsd === null ? 'local' : `$${event.costUsd.toFixed(4)}`}`,
              })
```

6. Replace the `detail` computation in `if (failure && !answer)` with:

```ts
      const detail = failure.kind === 'usage_limit'
        ? 'The model provider reported a rate or usage limit. Try again later.'
        : failure.kind === 'auth' && failure.message !== MISSING_API_KEY
          ? 'The Anthropic API rejected ANTHROPIC_API_KEY. Check the key, then restart OpenDots.'
          : failure.message
```

Run: `pnpm exec tsx --test src/lib/ai/agents/run-bot-turn.test.ts`
Expected: PASS (all tests in the file, including the new one).

- [ ] **Step 8: Health, client copy, comments**

Replace `src/app/api/health/route.ts` with:

```ts
import { NextResponse } from 'next/server'
import { describeAiConfig } from '@/lib/ai/config'
import { buildModelOptions } from '@/lib/ai/model-catalog'
import { DEFAULT_MODEL_ID, OLLAMA_PREFIX } from '@/lib/domain/models'
import { describeStore, getRepository } from '@/lib/repository'

/**
 * What is actually wired up: the brain, the models this server can run, the
 * store, and plain-language advice for anything missing. Probes Ollama with a
 * 1.5 s timeout, so it stays inside the container healthcheck's 3 s.
 */
export async function GET() {
  const catalog = await buildModelOptions()
  const channels = await getRepository().listChannels().catch(() => [])
  const botModels = channels
    .flatMap((channel) => (channel.assistant ? [channel.assistant.model] : []))
    .map((model) => (model === DEFAULT_MODEL_ID ? catalog.defaultModel : model))
  const usable = catalog.options.some((option) => option.provider !== 'default' && option.available)
  const advice = [
    ...(usable
      ? []
      : ['No model is usable yet. Set ANTHROPIC_API_KEY, or start Ollama and pull a model that supports tools (https://ollama.com/search?c=tools).']),
    ...(botModels.some((model) => model.startsWith(OLLAMA_PREFIX))
      ? ['Some bots run on Ollama. Raise its context window or long chats get cut off: OLLAMA_CONTEXT_LENGTH=32768 ollama serve']
      : []),
  ]

  return NextResponse.json({
    status: 'ok',
    service: 'opendots',
    ai: describeAiConfig(),
    models: {
      default: catalog.defaultModel,
      usable,
      ollama: { ...catalog.ollama, toolModels: catalog.options.filter((option) => option.provider === 'ollama').length },
    },
    store: describeStore(),
    advice,
  })
}
```

In `src/hooks/useChat.ts`, replace

```ts
              kind === 'usage_limit'
                ? 'Claude usage limit reached for this subscription window. The bot will answer again once it resets.'
                : kind === 'auth'
                  ? 'Claude is not logged in on this machine. Run `claude login` in a terminal, then retry.'
                  : (detail ?? 'Bot could not respond'),
```

with

```ts
              kind === 'usage_limit'
                ? 'The model provider reported a rate or usage limit. The bot will answer again once it resets.'
                : (detail ?? 'Bot could not respond'),
```

Comments: in `src/lib/ai/respond-stream.ts` change "keeps spending subscription usage" to "keeps spending API usage"; in `scripts/run-evals.ts` change "the suite never spends subscription usage" to "the suite never calls a model".

- [ ] **Step 9: Run everything**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm eval`
Expected: all exit 0; eval `15 passed, 2 skipped`.
Then: `grep -rn -i -E "subscription|claude login|setup-token|CLAUDE_CODE_OAUTH" src scripts`
Expected: no output except `src/lib/ai/brain-env.ts` (the comment saying there is no subscription path) and `src/lib/ai/brain-env.test.ts` (which asserts the token is dropped).

- [ ] **Step 10: Commit**

```bash
git add -A src/lib/ai src/app/api/health/route.ts src/hooks/useChat.ts scripts/run-evals.ts
git commit -m "feat: run bots on the Anthropic API or Ollama, with a workspace guard on every run

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Storage — PGlite by default, migrations on first use

**Files:**
- Modify: `package.json` (dependencies; `test` script), `pnpm-lock.yaml`, `pnpm-workspace.yaml` (only if the release-age policy blocks)
- Rewrite: `src/lib/db.ts`
- Create: `src/lib/migrate.ts`, `src/lib/migrate.test.ts`
- Modify: `src/lib/repository/postgres-store.ts` (import, constructor, `db` getter, `seedIfEmpty`, `this.pool.` → `this.db.`)
- Rewrite: `src/lib/repository/index.ts`
- Create: `src/lib/repository/contract.ts`, `src/lib/repository/postgres-store.test.ts`
- Rewrite: `src/lib/repository/memory-store.test.ts`
- Rewrite: `scripts/db-init.ts`; Modify: `scripts/run-evals.ts`
- Modify: `next.config.ts`

**Interfaces:**
- Produces (`db.ts`): `interface Db { query<T>(sql, params?): Promise<{ rows: T[]; rowCount: number }>; exec(sql): Promise<void>; transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> }`, `type StoreKind = 'pglite' | 'postgres' | 'memory'`, `storeKind(env?)`, `openPglite(dir?)`, `pgliteDb(pg)`, `pgDb(pool)`, `getPool()`, `openDb(kind?)`, `getDb(): Db`.
- Produces (`migrate.ts`): `MIGRATIONS_DIR`, `migrate(db: Db, dir?: string): Promise<string[]>`.
- Produces: `new PostgresChatRepository(db?: Db)`; `repositoryContract(label: string, getRepo: () => Promise<ChatRepository>)`.
- Deleted exports from `db.ts`: `isDatabaseConfigured`, `pingDatabase`, `toVectorLiteral` (verified: no importers anywhere in `src` or `scripts`).

- [ ] **Step 1: Add the dependencies and isolate unit tests from the default store**

```bash
pnpm add @electric-sql/pglite@0.5.8 @electric-sql/pglite-pgvector@0.0.9
```

If the release-age policy blocks either, add `'@electric-sql/pglite@0.5.8'` and/or `'@electric-sql/pglite-pgvector@0.0.9'` to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` and re-run.

In `package.json`, change the `test` script to:

```json
"test": "DATA_STORE=memory tsx --test \"src/**/*.test.ts\"",
```

(Unit tests that go through `getRepository()` share state with tests that use `memoryRepository` directly; with PGlite as the new default they must say so explicitly.)

- [ ] **Step 2: Write the failing migration and Db tests**

`src/lib/migrate.test.ts`:

```ts
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openPglite, pgliteDb } from './db'
import { migrate } from './migrate'

test('migrate applies every db/*.sql once and records each file', async () => {
  const db = pgliteDb(await openPglite())
  const first = await migrate(db)
  assert.deepEqual(first, ['001_init.sql', '002_bots.sql', '003_screens.sql'])
  assert.deepEqual(await migrate(db), [], 'a second run applies nothing')

  const { rows } = await db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')
  assert.deepEqual(rows.map((row) => row.name), first)
  const tables = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  )
  for (const table of ['channels', 'messages', 'bot_sessions', 'screens', 'skills']) {
    assert.ok(tables.rows.some((row) => row.table_name === table), `${table} exists`)
  }
})

test('a failing migration rolls everything back and records nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-migrate-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, '001_ok.sql'), 'CREATE TABLE ok_t (id INT);')
  writeFileSync(join(dir, '002_bad.sql'), 'CREATE TABLE bad_t (id INT);\nSELECT * FROM no_such_table;')

  const db = pgliteDb(await openPglite())
  await assert.rejects(migrate(db, dir), /no_such_table/)
  const { rows } = await db.query<{ ok: string | null; log: string | null }>(
    `SELECT to_regclass('public.ok_t')::text AS ok, to_regclass('public.schema_migrations')::text AS log`,
  )
  assert.deepEqual(rows[0], { ok: null, log: null })
})

test('PGlite returns bigint columns as strings, exactly like node-postgres', async () => {
  const db = pgliteDb(await openPglite())
  const { rows } = await db.query<{ n: unknown }>('SELECT 9007199254740993::bigint AS n')
  assert.equal(rows[0]?.n, '9007199254740993')
})

test('rowCount counts affected rows for writes and returned rows for reads', async () => {
  const db = pgliteDb(await openPglite())
  await db.exec('CREATE TABLE t (id INT); INSERT INTO t VALUES (1), (2), (3);')
  assert.equal((await db.query('DELETE FROM t WHERE id > 1')).rowCount, 2)
  assert.equal((await db.query('DELETE FROM t WHERE id > 100')).rowCount, 0)
  assert.equal((await db.query('SELECT * FROM t')).rowCount, 1)
})
```

Run: `pnpm exec tsx --test src/lib/migrate.test.ts`
Expected: FAIL — `openPglite` / `./migrate` not found.

- [ ] **Step 3: Implement `src/lib/migrate.ts`**

```ts
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from './db'

/** db/*.sql, resolved from the working directory: the app root in dev and tests, /app in the container. */
export const MIGRATIONS_DIR = join(process.cwd(), 'db')

/**
 * Applies every migration not yet recorded in `schema_migrations`, in name
 * order, inside one transaction: a failing file leaves the database exactly
 * as it was. The advisory lock serialises two app instances starting against
 * one Postgres server. Returns the files this call applied.
 */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = readdirSync(dir).filter((file) => file.endsWith('.sql')).sort()
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('opendots_migrate'))")
    await tx.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
    const { rows } = await tx.query<{ name: string }>('SELECT name FROM schema_migrations')
    const done = new Set(rows.map((row) => row.name))
    const applied: string[] = []
    for (const file of files) {
      if (done.has(file)) continue
      await tx.exec(readFileSync(join(dir, file), 'utf8'))
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
      applied.push(file)
    }
    return applied
  })
}
```

- [ ] **Step 4: Rewrite `src/lib/db.ts`**

```ts
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite, types, type Transaction } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { Pool, type QueryResult } from 'pg'
import { dataDir } from './data-dir'
import { migrate } from './migrate'

/**
 * The storage seam under PostgresChatRepository. Both implementations speak
 * the same SQL: PGlite (Postgres compiled to WASM, embedded, the default) and
 * a Postgres server through a `pg` pool when DATA_STORE=postgres.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>
  /** Runs a script of several statements with no parameters (migrations). */
  exec(sql: string): Promise<void>
  /** Runs `fn` inside one transaction; a throw rolls all of it back. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>
}

export type StoreKind = 'pglite' | 'postgres' | 'memory'

export function storeKind(env: NodeJS.ProcessEnv = process.env): StoreKind {
  return env.DATA_STORE === 'postgres' || env.DATA_STORE === 'memory' ? env.DATA_STORE : 'pglite'
}

const noNesting = async (): Promise<never> => {
  throw new Error('Nested transactions are not supported')
}

// ---- PGlite -----------------------------------------------------------------

/** int8 stays a string, as node-postgres returns it, so both backends hand the repository identical rows. */
const PARSERS = { [types.INT8]: (value: string) => value }

/** An embedded database: file-backed under `dir`, or in memory when `dir` is omitted (tests). */
export async function openPglite(dir?: string): Promise<PGlite> {
  if (dir) mkdirSync(dir, { recursive: true })
  return PGlite.create({ ...(dir ? { dataDir: dir } : {}), extensions: { vector }, parsers: PARSERS })
}

function pgliteHandle(handle: PGlite | Transaction, transaction: Db['transaction']): Db {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const result = await handle.query<T>(sql, params)
      return { rows: result.rows, rowCount: result.affectedRows || result.rows.length }
    },
    async exec(sql: string) {
      await handle.exec(sql)
    },
    transaction,
  }
}

export function pgliteDb(pg: PGlite): Db {
  return pgliteHandle(pg, (fn) => pg.transaction((tx) => fn(pgliteHandle(tx, noNesting))))
}

// ---- Postgres server ----------------------------------------------------------

type Queryable = { query(sql: string, params?: unknown[]): Promise<QueryResult> }

function pgHandle(client: Queryable, transaction: Db['transaction']): Db {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const result = await client.query(sql, params)
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 }
    },
    async exec(sql: string) {
      await client.query(sql)
    },
    transaction,
  }
}

export function pgDb(pool: Pool): Db {
  return pgHandle(pool, async (fn) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(pgHandle(client, noNesting))
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  })
}

/*
 * Parked on globalThis: hot reload re-evaluates modules, a fresh pool per
 * reload leaks connections, and a second PGlite on the same data directory
 * would corrupt it.
 */
const globalForDb = globalThis as typeof globalThis & { __pgPool?: Pool; __opendotsDb?: Db }

export function getPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set: DATA_STORE=postgres needs a Postgres connection string')
  }
  globalForDb.__pgPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    // Well under Postgres' default max_connections (100), so migrations and
    // psql sessions still get in while the app runs.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })
  return globalForDb.__pgPool
}

/** Opens a backend without migrating it. `close` is for scripts; the app keeps its database for the process lifetime. */
export async function openDb(
  kind: 'pglite' | 'postgres' = storeKind() === 'postgres' ? 'postgres' : 'pglite',
): Promise<{ db: Db; close: () => Promise<void> }> {
  if (kind === 'postgres') {
    const pool = getPool()
    return { db: pgDb(pool), close: () => pool.end() }
  }
  const pg = await openPglite(join(dataDir(), 'db'))
  return { db: pgliteDb(pg), close: () => pg.close() }
}

/** Defers opening (async) to the first query, so callers get a Db synchronously. */
function lazyDb(open: () => Promise<Db>): Db {
  let ready: Promise<Db> | null = null
  const get = () =>
    (ready ??= open().catch((error: unknown) => {
      ready = null // a failed open is retried by the next caller, not cached
      throw error
    }))
  return {
    async query<T>(sql: string, params?: unknown[]) {
      return (await get()).query<T>(sql, params)
    },
    async exec(sql: string) {
      return (await get()).exec(sql)
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      return (await get()).transaction(fn)
    },
  }
}

/** The process-wide database: opened and migrated on first use, so nobody has to run db:init first. */
export function getDb(): Db {
  globalForDb.__opendotsDb ??= lazyDb(async () => {
    const { db } = await openDb()
    await migrate(db)
    return db
  })
  return globalForDb.__opendotsDb
}
```

Run: `pnpm exec tsx --test src/lib/migrate.test.ts`
Expected: PASS (4 tests). If `pgliteDb`'s arrow does not type-check against the generic `Db['transaction']`, annotate it: `<T,>(fn: (tx: Db) => Promise<T>) => pg.transaction((tx) => fn(pgliteHandle(tx, noNesting)))`.

- [ ] **Step 5: Turn the memory-store tests into a shared contract**

Create `src/lib/repository/contract.ts` — the seven existing tests, written against any `ChatRepository`:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ROSTER } from '../domain/roster'
import { isUserMessage } from '../domain/types'
import type { ChatRepository } from './chat-repository'

/**
 * The behaviour every ChatRepository must share. Registered once per store
 * (memory-store.test.ts, postgres-store.test.ts) so the embedded database is
 * held to exactly what the in-memory store already promises.
 */
export function repositoryContract(label: string, getRepo: () => Promise<ChatRepository>): void {
  test(`${label}: seed is the roster, each bot with one intro message from itself`, async () => {
    const repo = await getRepo()
    const channels = await repo.listChannels()
    assert.equal(channels.length, ROSTER.length)
    const chief = channels.find((c) => c.assistant?.name === 'Chief of Staff')
    assert.ok(chief)
    assert.equal(chief.channelUrl, 'bot_chief-of-staff')
    const thread = await repo.listMessages(chief.channelUrl)
    assert.equal(thread?.length, 1)
    const first = thread![0]!.message
    assert.ok(isUserMessage(first))
    assert.equal(first.sender.userId, `bot_${chief.channelUrl}`)
    assert.equal(first.sender.nickname, 'Chief of Staff')
  })

  test(`${label}: assistant replies are attributed to the bot, not a shared Assistant user`, async () => {
    const repo = await getRepo()
    const created = await repo.createChannel({
      name: 'Apartment Hunter',
      assistant: { ...(await repo.listChannels())[0]!.assistant!, name: 'Apartment Hunter', avatar: { shape: 'cloud', color: 'green' } },
    })
    const reply = await repo.appendAssistantMessage(created.channelUrl, 'found 3 listings')
    assert.equal(reply.sender.nickname, 'Apartment Hunter')
    assert.equal(reply.sender.colorToken, 'green')
  })

  test(`${label}: bot sessions are stored per channel and cleared on delete`, async () => {
    const repo = await getRepo()
    const created = await repo.createChannel({ name: 'Temp', assistant: (await repo.listChannels())[0]!.assistant! })
    assert.equal(await repo.getBotSession(created.channelUrl), null)
    await repo.setBotSession(created.channelUrl, 'sess-1')
    assert.equal(await repo.getBotSession(created.channelUrl), 'sess-1')
    await repo.clearBotSession(created.channelUrl)
    assert.equal(await repo.getBotSession(created.channelUrl), null)
    await repo.setBotSession(created.channelUrl, 'sess-2')
    await repo.deleteChannel(created.channelUrl)
    assert.equal(await repo.getBotSession(created.channelUrl), null)
  })

  test(`${label}: listSkillIds tracks listSkills without the bodies, including deletes`, async () => {
    const repo = await getRepo()
    const before = await repo.listSkillIds()
    const created = await repo.createSkill({
      fileName: 'skill-ids-check.md',
      content: 'A skill uploaded only to exercise listSkillIds.',
    })
    assert.deepEqual(new Set(await repo.listSkillIds()), new Set([...before, created.id]))
    await repo.deleteSkill(created.id)
    assert.deepEqual(new Set(await repo.listSkillIds()), new Set(before))
  })

  test(`${label}: renaming a bot renames its conversation, not just the config`, async () => {
    const repo = await getRepo()
    const template = (await repo.listChannels())[0]?.assistant
    assert.ok(template)
    const created = await repo.createChannel({ name: 'Old Name', assistant: { ...template, name: 'Old Name' } })
    const updated = await repo.updateAssistant(created.channelUrl, { ...template, name: 'New Name' })
    assert.equal(updated.name, 'New Name')
    assert.equal((await repo.getChannel(created.channelUrl))?.name, 'New Name')
    const listed = (await repo.listChannels()).find((c) => c.channelUrl === created.channelUrl)
    assert.equal(listed?.name, 'New Name', 'the sidebar reads the channel name, so a rename must reach it')
    assert.equal(listed?.assistant?.name, 'New Name')
  })

  test(`${label}: screens append, list by turn, attach to a message, and cascade on delete`, async () => {
    const repo = await getRepo()
    const created = await repo.createChannel({ name: 'Screens Bot', assistant: (await repo.listChannels())[0]!.assistant! })
    const base = { channelUrl: created.channelUrl, turnId: 't1', action: 'open', target: null, intent: 'open it', url: 'https://example.com/', title: 'Example', annotations: [], flagged: false }
    const first = await repo.appendScreen({ ...base, step: 1, imagePath: '/tmp/1.jpg' })
    const second = await repo.appendScreen({ ...base, step: 2, imagePath: null, action: 'click', target: '@e1' })
    assert.equal(first.imageUrl, `/api/channels/${created.channelUrl}/screens/${first.screenId}`)
    assert.equal(second.imageUrl, null)
    const listed = await repo.listScreens(created.channelUrl, { turnId: 't1' })
    assert.deepEqual(listed.map((s) => s.step), [1, 2])
    assert.equal(await repo.getScreenImagePath(created.channelUrl, first.screenId), '/tmp/1.jpg')
    assert.equal(await repo.getScreenImagePath('other', first.screenId), null)
    assert.equal(
      await repo.getScreenImagePath(created.channelUrl, first.screenId, { attachedOnly: true }),
      null,
      'an unattached frame is withheld from the attached-only lookup',
    )
    const reply = await repo.appendAssistantMessage(created.channelUrl, 'done')
    await repo.attachScreensToMessage(created.channelUrl, 't1', reply.messageId)
    assert.ok((await repo.listScreens(created.channelUrl)).every((s) => s.messageId === reply.messageId))
    assert.equal(
      await repo.getScreenImagePath(created.channelUrl, first.screenId, { attachedOnly: true }),
      '/tmp/1.jpg',
      'once attached to the stored reply the same frame is servable',
    )
    await repo.deleteChannel(created.channelUrl)
    assert.deepEqual(await repo.listScreens(created.channelUrl), [])
  })

  test(`${label}: listScreens orders interleaved turns by start time, newest first, steps ascending within a turn`, async () => {
    const repo = await getRepo()
    const created = await repo.createChannel({ name: 'Interleaved Bot', assistant: (await repo.listChannels())[0]!.assistant! })
    const base = { channelUrl: created.channelUrl, action: 'open', target: null, intent: 'open it', url: 'https://example.com/', title: 'Example', annotations: [], flagged: false, imagePath: null }
    await repo.appendScreen({ ...base, turnId: 't1', step: 1 })
    await repo.appendScreen({ ...base, turnId: 't2', step: 1 })
    await repo.appendScreen({ ...base, turnId: 't1', step: 2 })
    const listed = await repo.listScreens(created.channelUrl)
    assert.deepEqual(listed.map((s) => `${s.turnId}-${s.step}`), ['t2-1', 't1-1', 't1-2'])
  })
}
```

Replace the whole of `src/lib/repository/memory-store.test.ts` with:

```ts
import { repositoryContract } from './contract'
import { memoryRepository } from './memory-store'

repositoryContract('memory', async () => memoryRepository)
```

Create `src/lib/repository/postgres-store.test.ts`:

```ts
import { openPglite, pgliteDb } from '../db'
import { migrate } from '../migrate'
import { repositoryContract } from './contract'
import { PostgresChatRepository } from './postgres-store'

/** One in-memory PGlite for the whole contract, mirroring the memory store's single shared instance. */
let repo: PostgresChatRepository | undefined

repositoryContract('pglite', async () => {
  if (!repo) {
    const db = pgliteDb(await openPglite())
    await migrate(db)
    repo = new PostgresChatRepository(db)
  }
  return repo
})
```

Run: `pnpm exec tsx --test src/lib/repository/memory-store.test.ts`
Expected: PASS (7 tests, now labelled `memory: …`).
Run: `pnpm exec tsx --test src/lib/repository/postgres-store.test.ts`
Expected: FAIL — `PostgresChatRepository` takes no `db` argument yet.

- [ ] **Step 6: Make `PostgresChatRepository` take a `Db`**

In `src/lib/repository/postgres-store.ts`:

1. Replace `import { getPool } from '../db'` with `import { getDb, type Db } from '../db'`.
2. Replace

```ts
export class PostgresChatRepository implements ChatRepository {
  private seeded = false

  private get pool() {
    return getPool()
  }
```

with

```ts
export class PostgresChatRepository implements ChatRepository {
  private seeded = false

  /** Tests inject an in-memory PGlite; the app uses the process-wide database (PGlite or a server). */
  constructor(private readonly injected?: Db) {}

  private get db(): Db {
    return this.injected ?? getDb()
  }
```

3. Replace the body of `seedIfEmpty` (everything between its opening `{` and closing `}`) with:

```ts
    if (this.seeded || process.env.SEED_BOTS === '0') return

    await this.db.transaction(async (tx) => {
      // Advisory lock scoped to this transaction: a second concurrent seeder
      // (another request, or another instance on the same server) blocks here
      // until this one commits, so "check empty, then insert" cannot interleave.
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('opendots_seed'))")

      const { rows } = await tx.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM channels')
      if (Number(rows[0]?.n ?? '0') > 0) return

      for (const entry of ROSTER) {
        const channelUrl = channelUrlFor(entry.slug)
        const assistant = rosterAssistant(entry)
        const bot = botUserFor(channelUrl, assistant)
        await tx.query(
          `INSERT INTO channels (channel_url, name, member_count, is_frozen, assistant)
           VALUES ($1, $2, 2, FALSE, $3) ON CONFLICT (channel_url) DO NOTHING`,
          [channelUrl, entry.name, JSON.stringify(assistant)],
        )
        await tx.query(
          `INSERT INTO messages (channel_url, sender_id, sender_name, body, message_type)
           VALUES ($1, $2, $3, $4, 'user')`,
          [channelUrl, bot.userId, bot.nickname, entry.intro],
        )
        await tx.query(
          `INSERT INTO read_receipts (channel_url, user_id, read_at) VALUES ($1, $2, NOW()), ($1, $3, NOW())
           ON CONFLICT (channel_url, user_id) DO UPDATE SET read_at = EXCLUDED.read_at`,
          [channelUrl, me.userId, bot.userId],
        )
      }
    })
    this.seeded = true
```

4. Rename every remaining pool call:

```bash
perl -pi -e 's/this\.pool\./this.db./g' src/lib/repository/postgres-store.ts
grep -n "pool" src/lib/repository/postgres-store.ts
```

Expected: the grep prints nothing.

Run: `pnpm typecheck`
Expected: exit 0. (If a call site relied on a `pg`-only field such as `result.fields`, it fails here; the `Db` result has `rows` and `rowCount` only.)

Run: `pnpm exec tsx --test src/lib/repository/postgres-store.test.ts`
Expected: PASS (7 tests labelled `pglite: …`). A failure here is a real difference between the stores. Debug it with superpowers:systematic-debugging; do not weaken the contract.

- [ ] **Step 7: Choose the store from `DATA_STORE`**

Replace `src/lib/repository/index.ts` with:

```ts
import { storeKind, type StoreKind } from '../db'
import type { ChatRepository } from './chat-repository'
import { memoryRepository } from './memory-store'
import { PostgresChatRepository } from './postgres-store'

/**
 * Chooses the store from DATA_STORE: the embedded PGlite database by default,
 * a Postgres server with DATA_STORE=postgres, and the in-memory store for
 * tests and the eval. Routes depend on this, never on a concrete store.
 */

let cached: ChatRepository | undefined

export function getRepository(): ChatRepository {
  cached ??= storeKind() === 'memory' ? memoryRepository : new PostgresChatRepository()
  return cached
}

export function describeStore(): { kind: StoreKind } {
  return { kind: storeKind() }
}
```

- [ ] **Step 8: Scripts and Next config**

Replace `scripts/db-init.ts` with:

```ts
import { openDb, storeKind } from '../src/lib/db'
import { migrate } from '../src/lib/migrate'
import { loadEnv } from './load-env'

/**
 * `pnpm db:init`: applies pending db/*.sql migrations now. The app already
 * does this on first use; this is for readying a Postgres server before the
 * app starts, or for seeing what a migration run does.
 *
 * Stop OpenDots first when using the embedded database: two processes must
 * never open the same PGlite data directory.
 */
async function main() {
  loadEnv(process.cwd())
  const kind = storeKind()
  if (kind === 'memory') {
    console.error('DATA_STORE=memory keeps nothing on disk, so there is nothing to migrate.')
    process.exit(1)
  }
  const { db, close } = await openDb(kind)
  try {
    const applied = await migrate(db)
    console.log(applied.length > 0 ? `Applied: ${applied.join(', ')}` : 'Already up to date.')
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    )
    console.log(`Tables (${kind}): ${rows.map((row) => row.table_name).join(', ')}`)
  } finally {
    await close()
  }
}

void main()
```

In `scripts/run-evals.ts`, directly below `process.env.BRAIN_DRY_RUN = '1'`, add:

```ts
// And the in-memory store: the golden set uploads skills as fixtures, which
// must never land in the operator's real database.
process.env.DATA_STORE = 'memory'
```

In `next.config.ts`, replace the `serverExternalPackages` line and its comment with:

```ts
  // Loaded from node_modules, not bundled: the SDK resolves its CLI binary, and
  // PGlite its WASM and data files, relative to their own package paths.
  serverExternalPackages: [
    '@anthropic-ai/claude-agent-sdk',
    '@electric-sql/pglite',
    '@electric-sql/pglite-pgvector',
  ],
```

- [ ] **Step 9: Run everything, then a real smoke test on the embedded store**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm eval && pnpm build`
Expected: all exit 0; eval `15 passed, 2 skipped`; build completes.

Smoke (uses a scratch data dir and port so nothing local is touched):

```bash
export OPENDOTS_DATA_DIR=$(mktemp -d) BRAIN_DRY_RUN=1
pnpm exec next dev --turbopack -H 127.0.0.1 -p 3123 > /tmp/opendots-smoke.log 2>&1 &
sleep 12
curl -s 127.0.0.1:3123/api/channels | python3 -c "import sys,json; print(len(json.load(sys.stdin)['channels']), 'channels')"
curl -s -X POST 127.0.0.1:3123/api/channels/bot_chief-of-staff/messages -H 'content-type: application/json' -d '{"message":"persist me"}' > /dev/null
pkill -f "next dev --turbopack -H 127.0.0.1 -p 3123"; sleep 2
pnpm exec next dev --turbopack -H 127.0.0.1 -p 3123 >> /tmp/opendots-smoke.log 2>&1 &
sleep 12
curl -s 127.0.0.1:3123/api/channels/bot_chief-of-staff/messages | grep -c "persist me"
curl -s 127.0.0.1:3123/api/health | python3 -m json.tool | head -30
pkill -f "next dev --turbopack -H 127.0.0.1 -p 3123"
ls "$OPENDOTS_DATA_DIR"
```

Expected: `9 channels`; the grep prints `1` after the restart (the message survived); health shows `"store": {"kind": "pglite"}`; the data dir lists `db` and `workspaces`. If the POST body shape differs, read `src/app/api/channels/[channelUrl]/messages/route.ts` and use its field name.

- [ ] **Step 10: Commit**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml next.config.ts src/lib/db.ts src/lib/migrate.ts src/lib/migrate.test.ts src/lib/repository scripts/db-init.ts scripts/run-evals.ts
git commit -m "feat: embedded PGlite by default, migrations on first use, one repository contract

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 6: Safe defaults in the app — live model picker, honest labels, warnings, local-only server

**Files:**
- Create: `src/hooks/useModelOptions.ts`
- Modify: `src/components/NewBotDialog.tsx` (`ModelSelect`, placeholder, warning)
- Modify: `src/components/BotPanel.tsx` (badge, warning)
- Modify: `src/components/DeployedChat.tsx` (badge)
- Modify: `src/lib/domain/assistant.ts` (+ `shellBrowserWarning`), `src/lib/domain/assistant.test.ts`
- Modify: `src/lib/deployment-session.ts` (+ `sessionSecret`); Create: `src/lib/deployment-session.test.ts`
- Modify: `src/app/layout.tsx` (description), `package.json` (`dev`, `start`)

**Interfaces:**
- Consumes: `STATIC_MODEL_OPTIONS`, `ModelOption`, `modelBadge` (Task 2); `GET /api/models` → `{ models: ModelOption[]; defaultModel: string }` (Task 2).
- Produces: `useModelOptions(): ModelOption[]`; `SHELL_BROWSER_WARNING: string`; `shellBrowserWarning(tools: readonly ToolName[]): string | null`; `sessionSecret(env?): string`.

- [ ] **Step 1: Failing tests for the two pure helpers**

Append to `src/lib/domain/assistant.test.ts` (add `SHELL_BROWSER_WARNING, shellBrowserWarning` to its import from `./assistant`):

```ts
test('shell plus browser carries a warning; either alone does not', () => {
  assert.equal(shellBrowserWarning(['shell', 'web_browser']), SHELL_BROWSER_WARNING)
  assert.equal(shellBrowserWarning(['web_browser', 'files', 'shell']), SHELL_BROWSER_WARNING)
  assert.equal(shellBrowserWarning(['shell']), null)
  assert.equal(shellBrowserWarning(['web_browser', 'files']), null)
})
```

Create `src/lib/deployment-session.test.ts`:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sessionSecret } from './deployment-session'

test('an unset or empty secret falls back to a random key, never a known or empty one', () => {
  const unset = sessionSecret({})
  const empty = sessionSecret({ DEPLOYMENT_SESSION_SECRET: '' })
  assert.match(unset, /^[0-9a-f]{64}$/)
  assert.match(empty, /^[0-9a-f]{64}$/, 'Compose passes "" for an unset variable; that must not become the key')
  assert.notEqual(unset, empty)
  assert.equal(sessionSecret({ DEPLOYMENT_SESSION_SECRET: 'configured' }), 'configured')
})
```

Run: `pnpm exec tsx --test src/lib/domain/assistant.test.ts src/lib/deployment-session.test.ts`
Expected: FAIL — the helpers do not exist.

- [ ] **Step 2: Implement the helpers**

In `src/lib/domain/assistant.ts`, after `TOOL_CATALOG`, add:

```ts
export const SHELL_BROWSER_WARNING =
  'This bot can browse the web and run commands on this computer. A web page could tell it to run commands. Turn both on only for sites you trust.'

/** Browser + Terminal is the combination a web page can turn into commands on the host. */
export function shellBrowserWarning(tools: readonly ToolName[]): string | null {
  return tools.includes('shell') && tools.includes('web_browser') ? SHELL_BROWSER_WARNING : null
}
```

In `src/lib/deployment-session.ts`:
1. Change the crypto import to `import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'`.
2. Replace the comment and `const SESSION_SECRET = ...` block with:

```ts
/**
 * The HMAC key for share-link sessions. An unset OR EMPTY variable (Compose
 * passes "" for one that is unset) falls back to 32 random bytes per process:
 * a restart then invalidates every session, which is a visible failure rather
 * than sessions signed with a known or empty key.
 */
export function sessionSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEPLOYMENT_SESSION_SECRET || randomBytes(32).toString('hex')
}

const SESSION_SECRET = sessionSecret()
```

Run: `pnpm exec tsx --test src/lib/domain/assistant.test.ts src/lib/deployment-session.test.ts`
Expected: PASS.

- [ ] **Step 3: The live model list hook**

`src/hooks/useModelOptions.ts`:

```ts
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
```

- [ ] **Step 4: Use it in `ModelSelect`, label honestly, warn on shell + browser**

`src/components/NewBotDialog.tsx`:
1. Remove the `import { STATIC_MODEL_OPTIONS } from '@/lib/domain/models'` added in Task 2; add `import { useModelOptions } from '@/hooks/useModelOptions'`.
2. Add `shellBrowserWarning` to the import from `@/lib/domain/assistant`.
3. In `ModelSelect`, make the first line of the body `const options = useModelOptions()`, then change `STATIC_MODEL_OPTIONS.some(` to `options.some(`, and replace the `.map` that renders `<option>`s with:

```tsx
        {options.map((entry) => (
          <option key={entry.id} value={entry.id} disabled={!entry.available && entry.id !== value}>
            {entry.available ? entry.label : `${entry.label} (needs ANTHROPIC_API_KEY)`}
          </option>
        ))}
```

4. Change the custom input's `placeholder` to `"ollama/qwq:latest or claude-sonnet-5"`.
5. Inside the Tools `<fieldset>` (legend `Tools`), immediately before its closing `</fieldset>`, insert:

```tsx
              {shellBrowserWarning(tools) && (
                <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-800">
                  {shellBrowserWarning(tools)}
                </p>
              )}
```

`src/components/BotPanel.tsx`:
1. Add `shellBrowserWarning` to the import from `@/lib/domain/assistant`; add `import { modelBadge } from '@/lib/domain/models'`.
2. Replace `Claude · {assistant.model}` with `{modelBadge(assistant.model)}`.
3. Inside the edit form's Tools `<fieldset>`, immediately before its closing `</fieldset>`, insert the same `shellBrowserWarning(tools)` paragraph as above.

`src/components/DeployedChat.tsx`: add `import { modelBadge } from '@/lib/domain/models'` and replace `Claude · {channel.assistant.model}` with `{modelBadge(channel.assistant.model)}`.

`src/app/layout.tsx`: set `description` to
`'OpenDots — your always-on team of AI coworkers, on Claude or on local models through Ollama'`.

`package.json` scripts:

```json
"dev": "next dev --turbopack -H 127.0.0.1",
"start": "next start -H 127.0.0.1",
```

- [ ] **Step 5: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: all exit 0.

Run: `grep -rn "Claude · " src`
Expected: no output (every badge goes through `modelBadge`).

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useModelOptions.ts src/components/NewBotDialog.tsx src/components/BotPanel.tsx src/components/DeployedChat.tsx src/lib/domain/assistant.ts src/lib/domain/assistant.test.ts src/lib/deployment-session.ts src/lib/deployment-session.test.ts src/app/layout.tsx package.json
git commit -m "feat: live model picker, provider-accurate labels, shell+browser warning, local-only server

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Packaging — license, README, env example, Docker, CI

**Files:**
- Create: `LICENSE`, `.github/workflows/ci.yml`
- Rewrite: `README.md`, `.env.example`, `docker-compose.yml`
- Modify: `Dockerfile`, `.dockerignore`, `package.json` (`packageManager`, `engines`)

**Interfaces:**
- Consumes: every environment variable from the Global Constraints, each read by the file named in the README table below.

- [ ] **Step 1: `LICENSE`**

```text
MIT License

Copyright (c) 2026 Seongwoo Choi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: `.env.example`**

```bash
# OpenDots — copy to .env.local and adjust. Everything here is optional.

# --- Model: set at least one --------------------------------------------------
# Claude through the Anthropic API.
# ANTHROPIC_API_KEY=sk-ant-...
# Any other Anthropic-compatible endpoint (a LiteLLM proxy, OpenRouter, ...).
# ANTHROPIC_BASE_URL=
# Local models through Ollama (this is the default address).
# OLLAMA_HOST=http://localhost:11434
# What bots set to "Default" run on. Unset: Claude Sonnet when a key is set,
# otherwise the first local Ollama model that supports tools.
# OPENDOTS_DEFAULT_MODEL=ollama/qwq:latest

# --- Storage --------------------------------------------------------------------
# pglite (default, embedded, nothing to install) | postgres | memory (resets on restart)
# DATA_STORE=pglite
# Needed only for DATA_STORE=postgres.
# DATABASE_URL=postgres://opendots:opendots@localhost:5432/opendots
# Where the embedded database, bot workspaces and bot configuration live.
# OPENDOTS_DATA_DIR=./.opendots

# --- Bots -----------------------------------------------------------------------
# BOT_MAX_TURNS=12
# BOT_MAX_BUDGET_USD=1.00
# Answer with a canned dry-run reply instead of calling a model.
# BRAIN_DRY_RUN=1

# --- Share links ----------------------------------------------------------------
# Signs passcode sessions for shared conversations. Unset: a random key per
# process (restarting signs everyone out). Set one long random value to keep
# sessions across restarts; never commit it.
# DEPLOYMENT_SESSION_SECRET=

# --- The bot's browser (needs `npm i -g agent-browser`) ---------------------------
# AGENT_BROWSER_BIN=agent-browser
# OPENDOTS_BROWSER_VIEWPORT=1280x800
# OPENDOTS_SCREENSHOT_QUALITY=70
# OPENDOTS_BROWSER_TIMEOUT_MS=30000
```

- [ ] **Step 3: `README.md`**

Replace the whole file with:

````markdown
# OpenDots

An always-on team of AI coworkers that you run yourself. Each bot is a named teammate with its own role, tools, browser and workspace, and you message it the way you would message a person. Bots run on Claude through the Anthropic API, or entirely on your own machine through Ollama.

OpenDots is inspired by xAI's Grok Bot and OpenAI's Dots, and it is open source under the MIT license.

> **Early project.** Sign-in, image and file attachments, bots that work with each other, graph memory and workflow graphs are being built. See the [roadmap](#roadmap).

## What bots can do today

- **Hold a role.** Nine starter bots (Chief of Staff, EA, Inbox Manager, Sales Outbound, Talent Scout, Growth Marketer, Customer Support, Expense Manager, Invoice Collector), each with a short role prompt you can rewrite. Make your own with **+**.
- **Keep context.** Every bot keeps its own agent session, which survives a restart.
- **Use a real browser.** With the Browser tool a bot drives its own Chromium session. Every action is screenshotted into a timeline in the Screen tab, and you can switch to a visible window to watch or take over.
- **Work with files.** Each bot has a private workspace folder, and its file tools can't reach outside it.
- **Pick up skills.** A bot that lacks a capability can search [skills.sh](https://skills.sh) and install a skill into its own workspace.
- **Search your documents.** Upload Markdown documents for a bot to search before it answers.
- **Be shared.** Share one conversation behind a link and a passcode.

## Quick start

You need Node.js 22 or newer, pnpm (`corepack enable pnpm`), and either Ollama or an Anthropic API key.

```bash
git clone https://github.com/swchoi1994/opendots.git
cd opendots
pnpm install
pnpm dev            # http://127.0.0.1:3000
```

There is no database to set up. OpenDots keeps its data in an embedded Postgres ([PGlite](https://pglite.dev)) under `./.opendots`.

### Choose a model

**On your machine, with Ollama.** Install [Ollama](https://ollama.com), pull a model that supports tool calling, and start Ollama with a larger context window:

```bash
ollama pull qwq                                  # the model OpenDots was tested with; others: https://ollama.com/search?c=tools
OLLAMA_CONTEXT_LENGTH=32768 ollama serve
```

OpenDots looks for Ollama at `http://localhost:11434` (set `OLLAMA_HOST` for another address) and lists its tool-capable models in every bot's model picker as `ollama/<name>`.

**Claude, with an Anthropic API key.**

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env.local
```

Restart `pnpm dev` and Claude Sonnet, Opus and Haiku become selectable. Set `ANTHROPIC_BASE_URL` as well to use another Anthropic-compatible endpoint, such as a LiteLLM proxy or OpenRouter.

Bots set to **Default** run on `OPENDOTS_DEFAULT_MODEL` if you set it; otherwise on Claude Sonnet when a key is set; otherwise on the first local Ollama model that supports tools. `curl 127.0.0.1:3000/api/health` shows what was picked and what is missing.

OpenDots doesn't sign in with a Claude.ai subscription. Bots run on the Anthropic API or on Ollama.

## Safety model

OpenDots runs agents that act on your computer. These are the boundaries:

- **Local only.** `pnpm dev` and `pnpm start` listen on `127.0.0.1`. There is no sign-in yet, so anyone who can reach the port controls every bot. Don't expose an instance to a network until sign-in ships.
- **Files stay in the workspace.** Every call to Read, Write, Edit, Glob and Grep is checked, and a path outside the bot's workspace folder is refused, including one that leaves through a symlink or `~`.
- **Terminal means host access.** Shell commands run as your user and aren't confined. The Terminal tool is off by default, and the app warns when a bot has both Terminal and Browser.
- **Web pages are untrusted input.** Text a bot reads on a page can carry instructions. Keep a browsing bot's other tools to a minimum.
- **Secrets stay with the server.** A bot's process gets basic variables (`PATH`, `HOME`) and the credentials for its own model, nothing else. Database URLs and the share-link secret are withheld.
- **Share links are a passcode gate**, not accounts.
- **"Irreversible?" badges are hints.** They come from matching words like "Pay" or "Delete" in what the bot clicks, and they block nothing.

## Configuration

Put values in `.env.local` (see `.env.example`). All are optional.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | – | Lets bots run on Claude |
| `ANTHROPIC_BASE_URL` | – | Another Anthropic-compatible endpoint for non-Ollama models |
| `OLLAMA_HOST` | `http://localhost:11434` | Where Ollama answers |
| `OPENDOTS_DEFAULT_MODEL` | – | What "Default" bots run on, for example `ollama/qwq:latest` or `sonnet` |
| `DATA_STORE` | `pglite` | `pglite` (embedded), `postgres` (needs `DATABASE_URL`) or `memory` |
| `DATABASE_URL` | – | Postgres connection string for `DATA_STORE=postgres` |
| `OPENDOTS_DATA_DIR` | `./.opendots` | Embedded database, bot workspaces and bot configuration |
| `OPENDOTS_WORKSPACES_DIR` | `<data dir>/workspaces` | Moves just the bot workspaces |
| `SEED_BOTS` | – | `0` skips the nine starter bots on an empty database |
| `BOT_MAX_TURNS` | `12` | Tool-use rounds per reply |
| `BOT_MAX_BUDGET_USD` | – | Spend ceiling per reply (Anthropic models) |
| `BRAIN_DRY_RUN` | – | `1` answers with a canned reply, no model call |
| `DEPLOYMENT_SESSION_SECRET` | random per process | Signs share-link sessions |
| `RAG_ENABLED` | `true` | `false` turns document search off |
| `RAG_VECTOR_STORE` | `memory` | `memory` (lexical) today |
| `RAG_TOP_K` | `4` | Passages retrieved per question |
| `RAG_MIN_SCORE` | `0.05` | Drops weak matches |
| `RAG_CHUNK_SIZE` | `800` | Characters per indexed chunk |
| `RAG_CHUNK_OVERLAP` | `120` | Characters shared by adjacent chunks |
| `AGENT_BROWSER_BIN` | `agent-browser` | The browser CLI (`npm i -g agent-browser`) |
| `OPENDOTS_BROWSER_VIEWPORT` | `1280x800` | Bot browser window size |
| `OPENDOTS_SCREENSHOT_QUALITY` | `70` | JPEG quality of captured frames |
| `OPENDOTS_BROWSER_TIMEOUT_MS` | `30000` | Per-command browser timeout |

## Run with Docker

```bash
docker compose up --build
```

This starts OpenDots and a Postgres server with pgvector, both reachable only from `127.0.0.1`. The app finds Ollama on your machine at `host.docker.internal:11434`. To use Claude, export `ANTHROPIC_API_KEY` in your shell first. The image has no browser, so the Browser tool works only when you run OpenDots on the host with `pnpm dev` or `pnpm start`.

## Development

```bash
pnpm dev         # dev server on 127.0.0.1:3000
pnpm build       # production build
pnpm start       # serve the build on 127.0.0.1:3000
pnpm typecheck
pnpm lint
pnpm test        # unit tests, no network
pnpm eval        # golden set, always in dry-run
pnpm db:init     # apply migrations now (the app also does this on first use)
```

## Architecture

```
src/
├── app/                      Next.js routes: the chat UI, share-link pages, /api/*
├── components/               UI; ChatShell holds the state
├── hooks/                    client data fetching (useChat, useModelOptions)
└── lib/
    ├── domain/               bots, models, avatars, roster, types
    ├── repository/           ChatRepository: memory store and a Postgres store (PGlite or a server)
    ├── db.ts, migrate.ts     the database seam and migrations
    ├── bots/workspace.ts     each bot's folder
    ├── browser/              the agent-browser client
    └── ai/
        ├── brain.ts          one Agent SDK run per turn, on Anthropic or Ollama
        ├── brain-env.ts      what the bot's process is allowed to see
        ├── model-catalog.ts  models available now, and what "Default" means
        ├── agents/           the planner (no model calls) and the turn runner
        └── tools/            tool grants, the in-process MCP server, the workspace guard
```

The planner decides retrieval, the system prompt and tool grants without calling a model, which is what lets the golden set check bot configuration with no credentials. The turn runner then hands that plan to `brain.ts`, the only module that talks to the Agent SDK.

## Roadmap

- Sign-in with Google and Microsoft, and personal and team workspaces
- Images and files in chat
- A bot team: bots that message each other, ask each other for help, create new bots for you, and share group chats
- Graph memory: people, companies and decisions remembered across chats
- Workflow graphs: multi-step jobs you can see and edit

## Known limitations

- No sign-in yet (see the safety model).
- The browser isn't sandboxed, and the container image has no browser.
- Captured browser frames accumulate until their bot is deleted.
- Document search is lexical, so it misses paraphrases.
- Local models must support tool calling, and answer quality depends on the model.
- `pnpm test` sets `DATA_STORE` with a POSIX shell prefix, so on Windows run it from WSL or Git Bash.

## License

[MIT](LICENSE)
````

- [ ] **Step 4: Docker files**

Replace `docker-compose.yml` with:

```yaml
# OpenDots and a Postgres server with pgvector. Both ports are bound to
# 127.0.0.1: there is no sign-in yet, so nothing here should face a network.
#
#   docker compose up --build
#   docker compose logs -f app
#   docker compose down -v        (-v also drops the data volumes)

services:
  app:
    build:
      context: .
      target: runtime
    ports:
      - '127.0.0.1:3000:3000'
    environment:
      DATA_STORE: postgres
      # Service names are DNS inside the compose network.
      DATABASE_URL: postgres://opendots:opendots@postgres:5432/opendots
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      ANTHROPIC_BASE_URL: ${ANTHROPIC_BASE_URL:-}
      # Ollama on the host machine.
      OLLAMA_HOST: ${OLLAMA_HOST:-http://host.docker.internal:11434}
      OPENDOTS_DEFAULT_MODEL: ${OPENDOTS_DEFAULT_MODEL:-}
      BOT_MAX_TURNS: ${BOT_MAX_TURNS:-12}
      OPENDOTS_DATA_DIR: /data
      # Empty means a random key per process; set one to keep share-link sessions across restarts.
      DEPLOYMENT_SESSION_SECRET: ${DEPLOYMENT_SESSION_SECRET:-}
    extra_hosts:
      - 'host.docker.internal:host-gateway'
    volumes:
      - opendots-data:/data
    depends_on:
      # service_healthy, not service_started: the app migrates on first use and
      # must not race the database.
      postgres:
        condition: service_healthy
    restart: unless-stopped

  postgres:
    # pgvector ships the extension prebuilt; plain postgres:17 does not have it.
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: opendots
      POSTGRES_PASSWORD: opendots
      POSTGRES_DB: opendots
    ports:
      - '127.0.0.1:5432:5432'
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U opendots -d opendots']
      interval: 5s
      timeout: 3s
      retries: 10
    restart: unless-stopped

volumes:
  postgres-data:
  opendots-data:
```

In `Dockerfile`:
1. Change all three `FROM node:20-alpine` lines to `FROM node:22-alpine`.
2. After `COPY --from=build --chown=nextjs:nodejs /app/public ./public`, add:

```dockerfile
# Migrations run from the app on first use; they are read from ./db at runtime.
COPY --from=build --chown=nextjs:nodejs /app/db ./db
```

3. Replace the workspaces block

```dockerfile
# Bot workspaces (the Agent SDK cwd) live outside the app tree so a volume can
# hold them. Created and chowned here because nextjs cannot mkdir under /data.
RUN mkdir -p /data/workspaces && chown nextjs:nodejs /data/workspaces
```

with

```dockerfile
# OPENDOTS_DATA_DIR: bot workspaces and the bots' own configuration live
# outside the app tree so a volume can hold them. Created and chowned here
# because nextjs cannot mkdir under /.
RUN mkdir -p /data && chown nextjs:nodejs /data
```

4. Replace the comment above `HEALTHCHECK` with:

```dockerfile
# /api/health reads the database and probes Ollama with a 1.5 s timeout, so it
# answers inside the 3 s limit even when Ollama is not running.
```

In `.dockerignore`, delete the `INTERN-PROJECT.md` line and add `.opendots` and `docs`.

In `package.json`, add top-level fields:

```json
"packageManager": "pnpm@11.17.0",
"engines": { "node": ">=22" },
```

- [ ] **Step 5: CI**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
      - run: pnpm eval
```

- [ ] **Step 6: Check that every documented variable is read somewhere**

```bash
for v in $(grep -oE '^\| `[A-Z_]+`' README.md | tr -d '|` '); do
  grep -rqI --include='*.ts' --include='*.tsx' -- "$v" src scripts || echo "UNREAD: $v"
done
grep -rn -i -E "subscription|claude login|setup-token|CLAUDE_CODE_OAUTH" --exclude-dir=node_modules --exclude-dir=docs --exclude-dir=.next . | grep -v -E "brain-env(\.test)?\.ts|README.md:.*Claude.ai subscription"
```

Expected: the loop prints nothing (every variable in the README table is read by some `.ts` file). The second grep prints nothing. (`brain-env.ts` names the subscription path in order to say it does not exist, `brain-env.test.ts` asserts the token is dropped, and the README says plainly that OpenDots doesn't use one.)

- [ ] **Step 7: Verify and commit**

Run: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm eval && pnpm build`
Expected: all exit 0.

```bash
git add LICENSE README.md .env.example docker-compose.yml Dockerfile .dockerignore .github/workflows/ci.yml package.json
git commit -m "docs: MIT license, a README for strangers, safe env example, local-only Docker, CI

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Live verification, pull request, merge (controller)

Run by the controller, not an implementer subagent. Every expectation is recorded in the PR body as **observed** (with evidence), **not observed** (why, and what was checked instead) or **failed**.

**Files:** none changed unless a check fails (then fix in a commit on `feat/core` and re-run that check).

- [ ] **Step 1: Pre-flight — what this machine can verify**

```bash
test -n "$ANTHROPIC_API_KEY" && echo "key: in this shell" || echo "key: not in this shell"
curl -s -m 3 localhost:11434/api/version
docker info --format '{{.ServerVersion}}'
command -v agent-browser || echo "agent-browser: not installed"
```

If no key is available, ask the owner once whether to provide one for check 5. Without it, check 5 is recorded as "not observed: no key provided".

- [ ] **Step 2: Push the branch and open the pull request**

```bash
git push -u origin feat/core
gh pr create --title "Core: Claude or Ollama, embedded PGlite, workspace guard, packaging" --body-file /tmp/opendots-pr-body.md
```

Write `/tmp/opendots-pr-body.md` first: a summary of Tasks 1–7, a link to the spec, and the verification table from Steps 3–8, which starts with every row marked pending. End the body with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 3: Fresh clone, zero infrastructure**

```bash
D=$(mktemp -d) && git clone -q --branch feat/core https://github.com/swchoi1994/opendots.git "$D/opendots" && cd "$D/opendots"
pnpm install --frozen-lockfile
PORT=3125 pnpm dev > "$D/dev.log" 2>&1 &
sleep 15
lsof -nP -iTCP:3125 -sTCP:LISTEN
curl -s 127.0.0.1:3125/api/health | python3 -m json.tool
curl -s 127.0.0.1:3125/api/channels | python3 -c "import sys,json; print(len(json.load(sys.stdin)['channels']))"
```

Expected: `lsof` shows the listener on `127.0.0.1:3125` only; health shows `store.kind = pglite` and `models.ollama.reachable = true`; `9` channels. Restart the dev server and confirm a message posted before the restart is still listed (as in Task 5, Step 9).

- [ ] **Step 4: An Ollama bot answers in the UI, with a tool call**

With that server running, open `http://127.0.0.1:3125` in a browser (Playwright or Chrome MCP). Open **Chief of Staff** → settings → Model → pick `qwq:latest (local)` → Save. Send: "Create a file named hello.md in your workspace containing one line, then tell me what you wrote." Capture a screenshot showing the tool activity and the reply. Then check the file exists under `$D/opendots/.opendots/workspaces/bot_chief-of-staff/hello.md`.

- [ ] **Step 5: The guard refuses in a live turn**

In the same thread send: "Use your Read tool on /etc/hosts and tell me its first line." Expected: the tool activity shows a failed Read, with "Bots can only use files inside their own workspace.", and the reply contains no line from `/etc/hosts`. A local model may decline to call the tool at all; record that as "not observed", with the reply text as evidence, and rely on the unit tests for the guard.

- [ ] **Step 6: A Claude bot answers (only with a key)**

Restart the dev server with the key in `.env.local`, set a bot to `sonnet`, send a short question, and screenshot the reply. Without a key: "not observed: no key provided".

- [ ] **Step 7: Docker from a clean checkout**

```bash
cd "$D/opendots" && docker compose up --build -d
sleep 30 && curl -s 127.0.0.1:3000/api/health | python3 -m json.tool
docker compose restart app && sleep 20
curl -s 127.0.0.1:3000/api/channels | python3 -c "import sys,json; print(len(json.load(sys.stdin)['channels']))"
docker compose down -v
```

Expected: health returns `status: ok` with `store.kind = postgres`; 9 channels after the restart. Port 3000 must be free first: stop any other local server on 3000 or record the conflict.

- [ ] **Step 8: CI, record, merge**

```bash
gh pr checks --watch
```

Expected: the `check` job passes. Update the PR body's table with every observation, then:

```bash
gh pr merge --merge --delete-branch
git checkout main && git pull
```

Confirm the merge with `git log --oneline -3` on `main` before reporting it.
