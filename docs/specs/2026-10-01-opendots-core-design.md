# OpenDots A: Core

**Date:** 2026-10-01
**Status:** Design approved in chat; this spec awaits owner review.
**Roadmap:** [2026-10-01-opendots-roadmap.md](2026-10-01-opendots-roadmap.md), sub-project A of six.

## 1. Goal

Make the imported EigenBots code safe and easy for a stranger to run, and let it run on more than one kind of model:

1. A bot's model can be Claude (through an Anthropic API key), an Ollama model, or a model behind any Anthropic-compatible endpoint.
2. `git clone`, `pnpm install`, `pnpm dev` works with no Docker, no database server, and no hand-built extension.
3. The defaults are safe for someone who installs it from a tweet.
4. The repository has a license, a README written for strangers, and CI.

### Non-goals

Sign-in and workspaces (B), attachments (C), bots talking to each other (F), graph memory (D), workflows (E), avatar restyling, and pgvector semantic retrieval (the lexical retriever stays).

## 2. Verified premises (2026-10-01, this Mac)

| Premise | Evidence |
| --- | --- |
| Ollama speaks the Anthropic Messages API | `POST localhost:11434/v1/messages` (Ollama 0.34.1) returned an Anthropic-shaped message from `llama3`, and a `tool_use` block from `qwq` |
| The Agent SDK runs a tool-using turn on Ollama | `query()` with `ANTHROPIC_BASE_URL=http://localhost:11434`, `ANTHROPIC_AUTH_TOKEN=ollama`, model `qwq:latest`, and an in-process MCP server called `opendots`: the model called `mcp__opendots__get_weather`, read the result, and answered. `result/success`, 2 turns, 52 s. The CLI logs `unrecognized_model` for the local model name but works. |
| The schema runs on PGlite | `db/001`–`003` applied unchanged on `@electric-sql/pglite` 0.5.8 with `@electric-sql/pglite-pgvector` 0.0.9, including the HNSW index, JSONB columns and `pg_advisory_xact_lock` |
| Granted tools skip `canUseTool` | Agent SDK permissions docs: "Auto-approved tools never reach `canUseTool`… For checks that must run on every tool call, use a `PreToolUse` hook." Today `Read`, `Write`, `Edit`, `Glob` and `Grep` are passed as bare `allowedTools`, so nothing checks their paths. |
| Docker works | Docker Engine 29.5.3 answers on this Mac, so the Compose path can finally be exercised |

A broken local model file (`gpt-oss:20b`, "size overflows") is a property of this machine, not of OpenDots.

## 3. Brain: choosing a model

### 3.1 Model ids and providers

A bot's `model` string decides the provider:

| `model` value | Provider | Model sent to the SDK |
| --- | --- | --- |
| `ollama/<name>`, for example `ollama/qwq:latest` | Ollama at `OLLAMA_HOST` (default `http://localhost:11434`) | `<name>` |
| anything else: `sonnet`, `opus`, `haiku`, or a full Claude model id | Anthropic | unchanged |

New module `src/lib/ai/providers.ts`:

```ts
export type ProviderId = 'anthropic' | 'ollama'
export interface ResolvedModel { provider: ProviderId; sdkModel: string }
export function resolveModel(model: string): ResolvedModel
export function brainEnv(resolved: ResolvedModel, source: NodeJS.ProcessEnv, dataDir: string): Record<string, string>
```

`brainEnv` builds the CLI subprocess environment. It replaces `scrubbedEnv` and keeps its deny-by-default rule:

- **Always:** `PATH`, `HOME`, `USER`, `TMPDIR`, `LANG`, `SHELL`, `NO_COLOR=1`, and `CLAUDE_CONFIG_DIR=<dataDir>/claude`. The config directory is OpenDots' own, so bots never read the operator's `~/.claude` (settings, login, memory) and their sessions don't land there.
- **Anthropic:** `ANTHROPIC_API_KEY`, plus `ANTHROPIC_BASE_URL` only when the operator set it (OpenRouter, a LiteLLM proxy, or any other Anthropic-compatible endpoint).
- **Ollama:** `ANTHROPIC_BASE_URL=<OLLAMA_HOST>`, `ANTHROPIC_AUTH_TOKEN=ollama`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL` and `ANTHROPIC_DEFAULT_HAIKU_MODEL` all set to the local model (so the CLI's background calls also stay local), and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. The operator's `ANTHROPIC_API_KEY` is never passed to an Ollama run.
- **Never:** `CLAUDE_CODE_OAUTH_TOKEN`, `DATABASE_URL`, `DEPLOYMENT_SESSION_SECRET`, Clerk keys, or anything else not listed above.

### 3.2 Checks before a run

`runBot` checks, before spawning the CLI:

- Anthropic model with no `ANTHROPIC_API_KEY`: yields `{ type: 'error', kind: 'auth', message: 'Set ANTHROPIC_API_KEY, or switch this bot to an Ollama model.' }` and never calls `query()`. There is no fallback to a claude.ai login.
- Ollama model: nothing extra. A connection failure, or a "model not found" from Ollama, is turned into a readable error: "Ollama isn't answering at <host>. Start it with `ollama serve`." or "<name> isn't pulled. Run `ollama pull <name>`."

### 3.3 Default model and the model list

- `OPENDOTS_DEFAULT_MODEL` replaces `CLAUDE_MODEL`. When it is unset, a new or seeded bot gets `sonnet` if `ANTHROPIC_API_KEY` is set; otherwise the first local Ollama model that lists the `tools` capability; otherwise `sonnet`, and `/api/health` reports that no model is usable.
- New route `GET /api/models` returns `{ id, label, provider, available }[]`: the Claude aliases (`available` only when a key is set) and every local Ollama model with the `tools` capability (read from `GET <OLLAMA_HOST>/api/tags`, 1.5 s timeout; an unreachable Ollama contributes nothing). `ModelSelect` loads this list and keeps its "Other…" free-text entry.
- Models without tool calling are left out of the list because every bot turn may use tools.

### 3.4 Cost, labels and health

- `BotEvent.result.costUsd` becomes `number | null`, and is `null` for Ollama runs. The trace reads "completed in N turn(s), local" instead of a dollar figure.
- The bot panel's "Claude · {model}" label becomes "{provider label} · {model}", for example "Ollama · qwq:latest".
- `describeBrain()` reports `{ mode, anthropic: { keySet, customBaseUrl }, ollama: { host } }`. `/api/health` adds an Ollama reachability probe and the tool-capable model count. When any bot uses Ollama, health also notes that Ollama's context window should be raised (`OLLAMA_CONTEXT_LENGTH=32768 ollama serve`). OpenDots can't read the running server's setting, so this is advice, not a measurement.
- `src/lib/ai/claude-code.ts` is renamed `src/lib/ai/brain.ts`. User-facing copy never calls the product "Claude Code" (Agent SDK branding rules). "Powered by Claude" is allowed where it is true.
- `@anthropic-ai/claude-agent-sdk` goes from 0.3.258 to the current 0.3.286. `permissionMode: 'default'` stays explicit.

## 4. Storage

### 4.1 Stores

`DATA_STORE` takes `pglite` (new default), `postgres` (needs `DATABASE_URL`) or `memory` (tests and the eval).

`src/lib/db.ts` becomes a small interface with two implementations:

```ts
export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>
}
export function getDb(): Db   // PGlite or pg Pool, chosen by DATA_STORE; parked on globalThis
```

- **PGlite:** one instance per process, file-backed at `<OPENDOTS_DATA_DIR>/db`, with the pgvector extension.
- **Postgres server:** the existing `pg` Pool behind the same interface.

`PostgresChatRepository` takes a `Db` instead of a `Pool`, and serves both `pglite` and `postgres`: the SQL is identical. Its seed transaction uses `db.transaction`.

### 4.2 Migrations

`migrate(db)` applies `db/*.sql` in name order and records each file in a `schema_migrations` table, so a new file applies exactly once. It runs automatically the first time the repository is used, for PGlite and for a Postgres server alike, so nobody has to run `pnpm db:init` first. `pnpm db:init` stays, as a manual way to run the same function.

### 4.3 Data directory

`OPENDOTS_DATA_DIR` (default `./.opendots`) holds `db/`, `workspaces/` and `claude/`. `OPENDOTS_WORKSPACES_DIR` still overrides the workspaces location.

### 4.4 Risks to verify during implementation

- Next.js may try to bundle PGlite's WASM files. If so, add `serverExternalPackages: ['@electric-sql/pglite', '@electric-sql/pglite-pgvector']` to `next.config.ts`.
- PGlite allows one connection. Concurrent route handlers share the instance, and `transaction` holds it for the length of the callback. The seed transaction is the only long one.

### 4.5 Compose

Verify `docker compose up` end to end: app, Postgres with pgvector, health green, a conversation surviving `docker compose restart app`. Publish the app port on `127.0.0.1` only.

## 5. Safe defaults

### 5.1 Network

`pnpm dev` and `pnpm start` bind to `127.0.0.1`. There is no sign-in until B, so the README says plainly not to expose an instance to a network.

### 5.2 File tools stay inside the bot's folder

A `PreToolUse` hook, added in `runBot` for every run, checks every call to `Read`, `Write`, `Edit`, `NotebookEdit`, `Glob` and `Grep`:

- **Paths checked:** `file_path`, `notebook_path` and `path`. For `Glob`, also `pattern` when it is absolute or contains `..`.
- **Resolution:** each value is resolved against the workspace. Then `realpath` is taken of the nearest existing ancestor, so a symlink inside the workspace can't point out of it.
- **Decision:** a path outside `realpath(workspaceDir)` is denied with "Bots can only use files inside their own workspace."

The logic is a pure function, `checkWorkspacePath(tool, input, workspaceDir)`, in `src/lib/ai/tools/workspace-guard.ts`.

`canUseTool` keeps its current job: denying tools the bot was not granted.

### 5.3 Shell and browser together

`shell` stays off by default. When a bot has both `shell` and `web_browser`, the bot panel and the new-bot dialog show: "This bot can browse the web and run commands on this computer. A web page could tell it to run commands. Turn both on only for sites you trust." The hook does not confine `Bash`; the README documents that shell access is access to the host.

### 5.4 Trust lists

| List | Change |
| --- | --- |
| Subprocess env allowlist (`brainEnv`) | Adds provider variables per provider, as in 3.1. Removes `CLAUDE_CODE_OAUTH_TOKEN`. Forces `CLAUDE_CONFIG_DIR` to OpenDots' own directory. |
| `canUseTool` | Unchanged: denies tools outside the bot's grants |
| New `PreToolUse` hook | Denies file-tool paths outside the bot's workspace |
| Tool grant map (`grants.ts`) | Unchanged |
| Default tools (`DEFAULT_ASSISTANT.tools`) | Unchanged: `rag_search`, `channel_history`, `files`, `skills`, `web_browser`; no `shell` |
| Share-link visitor grants | Unchanged |

## 6. Packaging

- **LICENSE:** MIT, copyright 2026 Seongwoo Choi.
- **README, rewritten:** what OpenDots is; a 3-command quick start; Ollama vs Claude setup; the safety model (5.1–5.3, and the existing limitations about untrusted page text); configuration; architecture; the roadmap with B–F listed as coming. The Homebrew "Without Docker" pgvector build section is deleted, since PGlite replaces it. No claims about users, stars or benchmarks.
- **`.env.example`:** `ANTHROPIC_API_KEY`, `OLLAMA_HOST`, `OPENDOTS_DEFAULT_MODEL`, `DATA_STORE`, `OPENDOTS_DATA_DIR`, with the old Claude-login lines removed.
- **UI copy:** `layout.tsx`'s description loses "on your subscription".
- **CI:** `.github/workflows/ci.yml` runs on push and pull request, Node 22, pnpm. Steps: install, `typecheck`, `lint`, `test`, `eval`.

## 7. Testing and verification

### 7.1 Unit tests (no network)

- `resolveModel`: Ollama prefix, Claude aliases, full Claude ids.
- `brainEnv`: never contains `CLAUDE_CODE_OAUTH_TOKEN`; an Ollama env never contains the operator's `ANTHROPIC_API_KEY`; an Anthropic env has no base URL unless the operator set one.
- `runBot` pre-flight: an Anthropic model with no key yields an `auth` error and `query()` is never called.
- `checkWorkspacePath`: `../` traversal, absolute paths, a symlink escape, an absolute Glob pattern, paths inside the workspace allowed.
- `migrate`: applies each file once, and re-running is a no-op.
- The repository contract suite runs against the memory store and an in-memory PGlite.
- The model-list builder with an injected `fetch`: Ollama up, Ollama down, no key.
- The golden set keeps running with `BRAIN_DRY_RUN=1`, and the eval runner forces `DATA_STORE=memory`.

### 7.2 Live checks (manual, recorded in the PR)

1. Fresh clone, `pnpm install`, `pnpm dev` with nothing else running: the app loads, the nine bots are seeded into PGlite, and they are still there after a restart.
2. An Ollama bot (`ollama/qwq:latest`) answers in the UI with a tool call visible.
3. A bot told to read `/etc/hosts` is refused by the hook, and the refusal shows in the tool activity.
4. A Claude bot answers with an API key, if the owner provides one for the check; otherwise the PR says this check was skipped.
5. `docker compose up` from a clean checkout reaches a green `/api/health`.

## 8. Done when

- Everything in 7.1 passes in CI, and 7.2 is recorded.
- `grep -ri "subscription\|claude login\|setup-token" --exclude-dir=docs --exclude-dir=node_modules .` finds nothing. The design docs quote the policy and are excluded on purpose.
- The private repository's `main` has the work, merged through a pull request.
