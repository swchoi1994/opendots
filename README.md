# OpenDots

OpenDots turns a team chat into a roster of **always-on AI teammates**. Each conversation
belongs to a persistent, named bot — Chief of Staff, EA, Inbox Manager, and so on — with its own
role, avatar, tool grants, and working directory. The brain behind every bot is **Claude on the
operator's own subscription**, reached through `@anthropic-ai/claude-agent-sdk` and the local
`claude` login. There is no Anthropic API key anywhere in this app.

---

## Project status

**Phase 1 and Phase 2 are done**: a Claude-backed brain, nine named bots with sessions that survive
a restart, skills.sh self-install, a three-pane iMessage-style UI, Postgres persistence, and now
**the bot's screen** — a `web_browser` tool so a bot can drive its own browser, with every action
streamed into the right panel as an annotated frame (see [The bot's
screen](#the-bots-screen) below). The full roadmap, from the Phase 1 design spec:

- **Phase 1b** — local embeddings (`@huggingface/transformers`) into pgvector, so semantic
  retrieval works with no external key.
- **Phase 2 — the bot's screen** (done) — `web_browser` via `agent-browser`, streamed `screen`
  events, headed takeover.
- **Phase 3 — Automations** — an `automations` table (cron + event triggers: webhooks, new
  messages, workspace file drops, other bots finishing a run), a worker that calls `runBotTurn`
  on trigger and posts the result into the thread.
- **Phase 4 — Approvals and plugins** — a configurable irreversible-action policy that pauses on
  `canUseTool` and renders an approve/deny card; MCP servers managed in a Plugins panel, granted
  per bot.
- **Phase 5 — Rooms and mobile** — multi-bot group chats with a coordinator, responsive layout.

---

## Requirements

- **Node.js >= 20.9** (Next.js 16 requirement)
- **pnpm** (`corepack enable pnpm`)
- **Claude Code installed and logged in**: `claude login` (the Agent SDK reuses that login — no
  API key). On a host with no Keychain (a container, a CI runner), run `claude setup-token` once
  and set `CLAUDE_CODE_OAUTH_TOKEN` instead.
- **Postgres with the `pgvector` extension**, either via Docker Compose (below) or the
  [Without Docker](#without-docker) path.
- **`agent-browser`** for the `web_browser` tool: `npm i -g agent-browser`. Without it on `PATH`,
  browsing tool calls fail with a clear error; every other feature works fine.

Everything is optional at boot except the schema step: with `DATA_STORE` unset the app runs on an
in-memory store that resets on restart, and `BRAIN_DRY_RUN=1` forces a deterministic dry-run
answer with no model call (this is what `pnpm eval` uses, so the golden set never spends usage).

---

## Quick start

```bash
pnpm install
docker compose up -d postgres     # Postgres 17 + pgvector; see "Without Docker" if this can't start
cp .env.example .env.local        # then edit DATABASE_URL / DATA_STORE as needed
pnpm db:init                      # applies db/*.sql — channels, messages, skills, bot_sessions, ...
pnpm dev                          # http://localhost:3000
```

The nine seeded bots appear on first request against an empty `channels` table (a lazy roster
seed); a non-empty table is left alone, so re-running `db:init` or restarting is always safe.

The Compose path (`docker compose up`) has not been exercised on the development machine —
Docker's engine did not start there — so the [Without Docker](#without-docker) path below is the
verified one.

### Without Docker

If Docker's engine won't start on your machine, a plain Homebrew Postgres 16 cluster works just as
well — this is how Phase 1 was developed and verified on this Mac:

1. Install Postgres 16 and build pgvector against it. The Homebrew `postgresql@16` bottle on
   Apple Silicon is an x86_64 (Rosetta) build, and the prebuilt pgvector bottle only targets
   pg17/pg18, so build the extension from source against your pg16 install:
   ```bash
   brew install postgresql@16
   git clone --branch v0.8.6 https://github.com/pgvector/pgvector.git
   cd pgvector
   make CC="clang -arch x86_64" PG_SYSROOT="$(xcrun --show-sdk-path)" \
        PG_CONFIG=/usr/local/opt/postgresql@16/bin/pg_config
   make install PG_CONFIG=/usr/local/opt/postgresql@16/bin/pg_config
   ```
2. Initialise a private data directory inside the repo (already gitignored under `.opendots/`)
   and start the server on a non-default port so it never collides with a system Postgres:
   ```bash
   /usr/local/opt/postgresql@16/bin/initdb -D .opendots/pgdata -U opendots
   /usr/local/opt/postgresql@16/bin/pg_ctl -D .opendots/pgdata \
     -o "-p 5439 -k /tmp -c listen_addresses=127.0.0.1" \
     -l .opendots/pgdata.server.log start
   /usr/local/opt/postgresql@16/bin/createdb -h 127.0.0.1 -p 5439 -U opendots opendots
   /usr/local/opt/postgresql@16/bin/psql -h 127.0.0.1 -p 5439 -U opendots -d opendots \
     -c 'CREATE EXTENSION vector;'
   ```
3. Point `.env.local` at it instead of the Compose URL:
   ```bash
   DATA_STORE=postgres
   DATABASE_URL=postgres://opendots@127.0.0.1:5439/opendots
   RAG_VECTOR_STORE=memory
   OPENDOTS_WORKSPACES_DIR=./.opendots/workspaces
   ```
4. `pnpm db:init` applies `db/*.sql` exactly as it would against the Compose database — the app
   never knows which path provided Postgres.
5. `pnpm dev` reads `.env.local` only at process start, so restart it (`pkill -f 'next dev
   --turbopack'` then `pnpm dev`) after writing or changing it.

Status/stop that cluster with:
```bash
/usr/local/opt/postgresql@16/bin/pg_ctl -D .opendots/pgdata status
/usr/local/opt/postgresql@16/bin/pg_ctl -D .opendots/pgdata stop
```

---

## How bots work

- **Workspace** — every bot gets one directory, `OPENDOTS_WORKSPACES_DIR/<sanitised channel
  url>`, created on first use (`src/lib/bots/workspace.ts`). It is the Agent SDK's `cwd`: where the
  bot's files live and where installed skills land under `.claude/skills/`.
- **Session** — the Agent SDK returns a `session_id` on each run; it is persisted per channel in
  `bot_sessions` and resumed on the next turn, so a bot's context survives a server restart. A lost
  or unknown session id is cleared and restarted rather than failing the turn.
- **Skills.sh self-install** — a bot that lacks a capability can call `find_skill` to search
  [skills.sh](https://skills.sh) and `install_skill` to pull a `SKILL.md` package (`owner/repo@skill`)
  straight into its own workspace; it becomes available on the bot's next turn
  (`src/lib/ai/tools/skills-sh.ts`, `src/lib/ai/tools/opendots-mcp.ts`).
- **Tools as a permission set** — each bot's `ToolName[]` (`rag_search`, `channel_history`,
  `files`, `shell`, `skills`, `web_browser`) maps to a concrete list of Agent SDK built-ins and
  in-process MCP tool names (`src/lib/ai/tools/grants.ts`). Only what is granted is passed as
  `allowedTools`; nothing outside that list is ever auto-approved for the bot's run.

---

## Configuration

Values live in `.env.local` (copy `.env.example`, loaded after `.env`, gitignored). Nothing here
touches the network at import time, so these modules are safe to load during `next build`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATA_STORE` | `memory` | `memory` or `postgres` — which `ChatRepository` the app uses |
| `DATABASE_URL` | – | Postgres connection string; required when `DATA_STORE=postgres` |
| `BRAIN_DRY_RUN` | unset | `1` forces the planner's dry-run answer, no SDK call — what `pnpm eval` sets |
| `CLAUDE_CODE_OAUTH_TOKEN` | unset | long-lived token for hosts with no Keychain login (`claude setup-token`) |
| `CLAUDE_MODEL` | `sonnet` | default model alias for new bots |
| `BOT_MAX_TURNS` | `12` | cap on tool-use rounds per turn |
| `BOT_MAX_BUDGET_USD` | unset | optional spend ceiling per turn |
| `OPENDOTS_WORKSPACES_DIR` | `./.opendots/workspaces` | per-bot working directories (the Agent SDK `cwd`) |
| `RAG_ENABLED` | `true` | turns Knowledge Search off entirely when `false` |
| `RAG_VECTOR_STORE` | `memory` | `memory` (lexical) today; `pgvector` returns a clear "not available" error until Phase 1b lands local embeddings |
| `RAG_TOP_K` | `4` | passages retrieved per query |
| `RAG_MIN_SCORE` | `0.05` | drop weak matches rather than padding the answer |
| `RAG_CHUNK_SIZE` | `800` | approximate characters per indexed chunk |
| `RAG_CHUNK_OVERLAP` | `120` | characters shared between adjacent chunks |
| `DEPLOYMENT_SESSION_SECRET` | per-process | HMAC key for deployed-link sessions |
| `AGENT_BROWSER_BIN` | `agent-browser` | the CLI binary the `web_browser` tool shells out to; override for a non-`PATH` install |
| `OPENDOTS_BROWSER_VIEWPORT` | `1280x800` | the bot browser's window size |
| `OPENDOTS_SCREENSHOT_QUALITY` | `70` | JPEG quality (1–100) for captured frames — lower trades fidelity for smaller `.screens/` files and faster SSE frames |
| `OPENDOTS_BROWSER_TIMEOUT_MS` | `30000` | per-command timeout for each `agent-browser` call (`browser_open` gets 2x this) |

`/api/health` reports the resolved brain and store state (`describeBrain()`, `describeStore()`),
so `curl localhost:3000/api/health` is the fastest way to confirm what's actually wired up.

---

## The bot's screen

A bot with `web_browser` granted drives a real, isolated Chromium session through eight tools —
`browser_open`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_fill`,
`browser_press`, `browser_scroll`, `browser_back` — implemented over the
[`agent-browser`](https://www.npmjs.com/package/agent-browser) CLI (`src/lib/browser/agent-browser.ts`,
`src/lib/ai/tools/browser-tools.ts`). Every *acting* tool call (everything except `browser_snapshot`,
which only re-reads the page) automatically captures an annotated screenshot afterward — the bot
never has to remember to; the timeline is complete by construction.

**Where frames live.** Each captured frame is written as a JPEG to
`<workspace>/.screens/<turnId>/<step>.jpg` under the bot's own workspace
(`OPENDOTS_WORKSPACES_DIR/<sanitised channel url>`), and a row is inserted into the `screens`
table (channel, turn, step, action, target, intent, url, title, image path, annotations, a
`flagged` bit for irreversible-looking targets like "Pay now" or "Delete"). While a turn is in
flight, each frame also streams to the open tab as an SSE `screen` event, so thumbnails appear
under the responding bubble live; once the turn finishes, the same frames are what `GET
/api/channels/:url/screens` returns on reload — nothing is SSE-only.

**The Screen tab.** The right panel's "Screen"/"Settings" tabs put the bot's screen one click away
(the monitor icon in the conversation header, pulsing while a turn is running a browser action).
It shows the latest frame full-size with numbered annotation boxes, the page's URL underneath, a
"Steps" list (newest turn first, oldest step first within a turn) with the bot's stated `intent`
for each action, and clicking the big frame opens a lightbox with the image at full size and a
legend translating each annotation number to a role and accessible name (`#3 button "Pay now"`).

**Headed takeover.** "Show window" in the Screen tab flips the bot's browser from headless to a
visible window on the host Mac (`PATCH /api/channels/:url/browser { headed: boolean }`, persisted
on `assistant.browser.headed`). The running session's mode doesn't change until the browser is
relaunched, so the route closes the current session — the next `browser_open` starts headed (or
back to headless on toggle-off). Closing the window, or toggling back, returns control to the bot.

**Login persistence.** Each bot gets its own `agent-browser` session, named from its channel url
(`browserSessionName`, e.g. `bot_chief-of-staff` → `bot_bot_chief-of-staff`), passed as both
`--session` and `--session-name`. The `--session-name` state file
(`~/.agent-browser/sessions/<name>-<name>.json`) persists cookies and storage to disk and is
reloaded on the next `browser_open`, so a bot that logs into a site stays logged in across turns,
across the bot's browser process being closed, and across a dev-server restart.

**Environment.** `AGENT_BROWSER_BIN`, `OPENDOTS_BROWSER_VIEWPORT`, `OPENDOTS_SCREENSHOT_QUALITY`,
and `OPENDOTS_BROWSER_TIMEOUT_MS` are documented in [Configuration](#configuration) above. Install
the CLI globally to enable browsing at all: `npm i -g agent-browser` (see
[Requirements](#requirements)).

**Enabling it on an older database.** Run `pnpm db:init` first: it applies `db/003_screens.sql`,
which adds the `screens` table the frames are stored in (without it, browsing still works but every
frame is dropped, and the server logs `[screens] persist failed`). Then the tool grant: `web_browser`
is in `DEFAULT_ASSISTANT.tools` for every bot seeded from Phase 2 onward. A database seeded before
Phase 2 has bots whose stored `assistant.tools` predates the flag — enable it per bot from the bot
panel's Settings tab (check "Browser"), or in bulk with:
```sql
UPDATE channels
SET assistant = jsonb_set(assistant, '{tools}', (assistant->'tools') || '"web_browser"')
WHERE NOT (assistant->'tools') ? 'web_browser';
```

---

## Known limitations

- **No operator login.** There is no authentication in front of the app — anyone who can reach the
  server can call every API route, including deleting bots and reading every conversation. Deployed
  share links are a UX gate (a passcode for a single read-only thread), not a security boundary.
  Do not expose an instance to an untrusted network. Operator auth is planned for Phase 4.
- **The browser is not sandboxed.** `web_browser` tool calls run `agent-browser` as the server's
  own OS user with the server's own network access; a bot's browsing session is isolated from other
  bots' browsing sessions (separate `agent-browser` sessions) but not from the host machine.
- **Page text is untrusted input.** Whatever a bot reads on a page — visible copy, hidden text, an
  element's accessible name — arrives in its context as ordinary text and can carry instructions.
  A bot that holds `web_browser` *and* `files` or `shell` can therefore be steered by a page into
  touching the host. Keep a browsing bot's other grants minimal until Phase 4 adds approval gates.
- **"irreversible?" is a hint, not a guard.** The amber badge comes from a keyword match against
  the accessible name of the element being clicked or typed into, and nothing else: an unnamed or
  oddly-named "Pay" button is not flagged, and `browser_open` and `browser_press` are never flagged
  (they carry no element name) — pressing Enter to submit a form goes unmarked. Nothing is blocked
  either way in Phase 2.
- **The container image ships no browser.** The Docker image installs no `agent-browser` and no
  Chromium, so browsing works only on the host-run (`pnpm dev`) path; in a container the tools
  return "Browser unavailable: install agent-browser".
- **The Compose path is unexercised.** `docker compose up` (see [Quick start](#quick-start)) has
  not been run on the development machine; only the [Without Docker](#without-docker) path is
  verified.
- **Frames are workspace files.** Captured JPEGs live on disk under the bot's workspace
  (`<workspace>/.screens/`); deleting a bot deletes its workspace, so its frames go with it. The
  `screens` table rows are removed the same way, on `ON DELETE CASCADE`.
- **Frames accumulate.** Nothing prunes them: every browser action a bot ever takes leaves a JPEG
  on disk and a row in `screens` until the bot itself is deleted. A long-lived browsing bot grows
  without bound. A retention policy (age and count caps) comes with Phase 3.
- **Replies render as plain text.** A bot's markdown (bold, code fences, lists) is not rendered in
  the chat UI today — it appears as literal `**`/backtick markup in the bubble.

---

## Scripts

```bash
pnpm dev         # dev server (Turbopack)
pnpm build       # production build
pnpm start       # serve the production build
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint (flat config)
pnpm test        # tsx --test over src/**/*.test.ts — unit tests, no network
pnpm eval        # golden set; BRAIN_DRY_RUN=1 always, exits non-zero on failure
pnpm db:init     # apply db/*.sql, in name order, to DATABASE_URL — idempotent
```

---

## Testing

```bash
pnpm test   # unit tests: config parsing, tool grants, skills.sh parsing, workspace safety, stores, browser
pnpm eval   # golden set: retrieval scoping, tool grants, memory, guardrails
```

`pnpm eval` forces `BRAIN_DRY_RUN=1` itself (`scripts/run-evals.ts`), so it runs deterministically
against the planner's dry-run answer and **never spends subscription usage**, in CI or locally. It
currently reports **15 passed, 2 skipped** — the two skips are the paraphrase cases, which need
semantic retrieval (Phase 1b).

---

## Architecture

```
src/
├── app/
│   ├── page.tsx                     server component -> <ChatShell/>
│   ├── app/[deploymentId]/page.tsx  standalone deployed-link view (passcode-gated)
│   └── api/
│       ├── channels/                list, get, messages, respond (SSE), deploy, read receipts
│       ├── deployments/             deployed-link thread, respond, unlock
│       ├── skills/                  upload / list / delete skill.md knowledge docs
│       ├── rag/search/              ad-hoc retrieval search
│       └── health/                  brain + store status
├── components/                      presentational; ChatShell holds the state
├── hooks/useChat.ts                 all client data-fetching (fetch + SSE parsing)
└── lib/
    ├── domain/                      types, roster (9 bots), seed, assistant config, skill parsing
    ├── repository/                  ChatRepository interface + memory + postgres stores
    ├── bots/workspace.ts            per-bot working directory (Agent SDK cwd)
    ├── db.ts                        Postgres pool
    ├── deployment-session.ts        HMAC-signed deployed-link sessions
    ├── ai/
    │   ├── config.ts                env-driven brain + RAG configuration
    │   ├── claude-code.ts           the brain: Agent SDK query() over the local `claude` login
    │   ├── respond-stream.ts        SSE framing for the respond route
    │   ├── guardrails/policies.ts   input block, output redaction
    │   ├── rag/                     lexical retriever + corpus
    │   ├── tools/                   grants.ts (permission map), opendots-mcp.ts (in-process MCP
    │   │                            server), skills-sh.ts (skills.sh client)
    │   └── agents/
    │       ├── bot-turn.ts          the planner: retrieval, prompt, grants, trace — model-free
    │       └── run-bot-turn.ts      one full turn: plan, run the brain, persist reply + session
    └── eval/                        golden set runner and cases
```

**The repository seam.** Route handlers depend only on the `ChatRepository` interface;
`getRepository()` picks the implementation from `DATA_STORE`. Moving from in-memory to Postgres
never touched a route, a component, or a test.

**The planner/brain split.** `planBotTurn` decides retrieval, the system prompt, tool grants, and
memory policy without calling a model, which is what lets the golden set assert bot *configuration*
deterministically; `runBotTurn` feeds that plan to `claude-code.ts`, which is the only module that
talks to the Agent SDK.

