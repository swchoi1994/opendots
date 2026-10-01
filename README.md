# OpenDots

An always-on team of AI coworkers that you run yourself. Each bot is a named teammate with its own role, tools, browser and workspace, and you message it the way you would message a person. Bots run on Claude through the Anthropic API, or entirely on your own machine through Ollama.

OpenDots is inspired by xAI's Grok Bot and OpenAI's Dots, and it is open source under the MIT license.

> **Early project.** Sign-in, image and file attachments, bots that work with each other, graph memory and workflow graphs are being built. See the [roadmap](#roadmap).

## What bots can do today

- **Hold a role.** Nine starter bots (Chief of Staff, EA, Inbox Manager, Sales Outbound, Talent Scout, Growth Marketer, Customer Support, Expense Manager, Invoice Collector), each with a short role prompt you can rewrite. Make your own with **+**.
- **Keep context.** Every bot keeps its own agent session, which survives a restart.
- **Use a real browser.** With the Browser tool a bot drives its own Chromium session. Every action is screenshotted into a timeline in the Screen tab, and you can switch to a visible window to watch or take over.
- **Work with files.** Each bot has a private workspace folder. Its file tools can't reach outside it, and they can't change the bot's own configuration.
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
- **Web pages can't drive your bots.** OpenDots answers only requests addressed to `127.0.0.1`, `localhost` or `[::1]` (or a name you list in `OPENDOTS_ALLOWED_HOSTS`), which stops DNS-rebinding tricks. API calls that change something are refused when they come from another site, so a page you visit can't post a message to a bot and make it act.
- **Files stay in the workspace.** Every call to Read, Write, Edit, NotebookEdit, Glob and Grep is checked, and a path outside the bot's workspace folder is refused, including one that leaves through a symlink or `~`.
- **Bots can't change their own configuration.** Write, Edit and NotebookEdit are refused for the workspace's `.claude/` folder (settings, skills, agents, commands, hooks), `.mcp.json`, `CLAUDE.md` and `CLAUDE.local.md`, including through a symlink or, on macOS and Windows, a different letter case. Those files decide what a bot's process runs, so a bot that could write them could give itself a shell. Bots can still read them, and skills still install through the Find and install skills tool.
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
| `OPENDOTS_ALLOWED_HOSTS` | – | Comma-separated extra host names the server answers to (for example `opendots.lan` or `box.local:8080`); loopback names always work |
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

Only one process at a time can open the embedded database. Stop the app before you run `pnpm db:init` against it, and don't run `pnpm dev` and `pnpm start` side by side on the same data directory: the second process stops with a message naming the one that holds it.

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
- The file guard checks each path before a tool runs; it is not an operating-system sandbox, so a symlink swapped in between the check and the file operation is not caught.
- Captured browser frames accumulate until their bot is deleted.
- Document search is lexical, so it misses paraphrases.
- Local models must support tool calling, and answer quality depends on the model.
- `pnpm test` sets `DATA_STORE` with a POSIX shell prefix, so on Windows run it from WSL or Git Bash.

## License

[MIT](LICENSE)
