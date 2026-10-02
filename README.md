# OpenDots

An always-on team of AI coworkers that you run yourself. Each bot is a named teammate with its own role, tools, browser and workspace, and you message it the way you would message a person. Bots run on Claude through the Anthropic API, or entirely on your own machine through Ollama.

OpenDots is inspired by xAI's Grok Bot and OpenAI's Dots, and it is open source under the MIT license.

> **Early project.** Image and file attachments, bots that work with each other, graph memory and workflow graphs are being built. See the [roadmap](#roadmap).

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

OpenDots looks for Ollama at `http://localhost:11434` (set `OLLAMA_HOST` for another address) and lists its tool-capable models in every bot's model picker as `ollama/<name>`. It was tested with Ollama 0.34; older versions may not report which models support tools, and then none are listed.

**Claude, with an Anthropic API key.**

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env.local
```

Restart `pnpm dev` and Claude Sonnet, Opus and Haiku become selectable. Set `ANTHROPIC_BASE_URL` as well to use another Anthropic-compatible endpoint.

Bots set to **Default** run on `OPENDOTS_DEFAULT_MODEL` if you set it; otherwise on Claude Sonnet when a key is set; otherwise on the first local Ollama model that supports tools, in the order Ollama lists them. With several models pulled, set `OPENDOTS_DEFAULT_MODEL` (for example `ollama/qwq:latest`) so the choice is yours. `curl 127.0.0.1:3000/api/health` shows what was picked and what is missing.

OpenDots doesn't sign in with a Claude.ai subscription. Bots run on the Anthropic API or on Ollama.

## Safety model

OpenDots runs agents that act on your computer. These are the boundaries:

- **Local unless sign-in is on.** `pnpm dev` and `pnpm start` listen on `127.0.0.1`. Without [sign-in](#sign-in-and-workspaces), anyone who can reach the port controls every bot, so `pnpm start` refuses any other address. With sign-in on, every API call except share links and the health check needs a signed-in person, and works only in that person's workspace.
- **Web pages can't drive your bots.** OpenDots answers only requests addressed to `127.0.0.1`, `localhost` or `[::1]` (or a name you list in `OPENDOTS_ALLOWED_HOSTS`), which stops DNS-rebinding tricks. Requests that change something are refused when they come from another site, so a page you visit can't post a message to a bot and make it act.
- **Files stay in the workspace.** Every call to Read, Write, Edit, NotebookEdit, Glob and Grep is checked, and a path outside the bot's workspace folder is refused, including one that leaves through a symlink or `~`.
- **Bots can't change their own configuration.** Write, Edit and NotebookEdit are refused for the workspace's `.claude/` folder (settings, skills, agents, commands, hooks), `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md` and any `.git/` folder, including through a symlink or, on macOS and Windows, a different letter case or a Unicode lookalike. Those files decide what a bot's process runs, so a bot that could write them could give itself a shell. Bots can still read them, and skills still install through the Find and install skills tool, which runs the installer outside the workspace so nothing a bot writes there (a `.npmrc`, say) can change what it downloads.
- **Terminal means host access.** Shell commands run as your user and aren't confined. The Terminal tool is off by default, and the app warns when a bot has both Terminal and Browser.
- **Web pages are untrusted input.** Text a bot reads on a page can carry instructions. Keep a browsing bot's other tools to a minimum.
- **Secrets stay with the server.** A bot's process gets basic variables (`PATH`, `HOME`) and the credentials for its own model, nothing else. Database URLs, the share-link secret and the Clerk keys are withheld.
- **Only operators give bots reach into the server.** Files, Terminal, Skills and Browser act on the server itself, and Terminal in any workspace reaches every workspace, the database and the server's keys. So with sign-in on, only the Clerk users you list in `OPENDOTS_OPERATORS` can turn them on for a bot, or show a bot's browser window, and only in workspaces where they are admins. A bot runs with the tools it has whoever messages it, so the operator who granted them vouches for it.
- **Share links are a passcode gate**, not accounts.
- **"Irreversible?" badges are hints.** They come from matching words like "Pay" or "Delete" in what the bot clicks, and they block nothing.

## Sign-in and workspaces

Sign-in is optional. Without it OpenDots is single-user and local: every request is you, and it listens only on `127.0.0.1`. With [Clerk](https://clerk.com) configured, people sign in with Google, Microsoft or email, and work in a workspace:

- **Personal:** yours alone, and you are its admin.
- **Operators:** the people who run the server, listed by Clerk user id in `OPENDOTS_OPERATORS`. Only they can give bots Files, Terminal, Skills or Browser (see the [safety model](#safety-model)). Leave it unset and nobody can: bots still chat, search documents and remember.
- **Teams:** Clerk organizations. Everyone in a team sees the same bots, chats and documents, and each message carries its sender's name. Organization admins (`org:admin`) are the team's admins.

Switch workspace from the menu at the bottom of the bot list.

### Set up Clerk

1. Create a Clerk application with Google and Microsoft sign-in, and Organizations on with personal accounts allowed.
2. Add these session token claims, which is where OpenDots reads names and pictures from: `name` = `{{user.full_name}}`, `image` = `{{user.image_url}}`, `email` = `{{user.primary_email_address}}`.
3. Put both keys in `.env.local`. With only one of them set, OpenDots stays local.
4. Sign in once, then list yourself as an operator with your Clerk user id (`user_…`, shown in the Clerk dashboard under Users, or by `clerk users list`).
5. Before anyone else can reach the server, decide who may sign up. Clerk lets anyone create an account by default; switch sign-ups to invitation-only (restricted) or a waitlist in the Clerk dashboard. Everyone who signs in can chat with bots, and the bots run on your model credentials.

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
OPENDOTS_OPERATORS=user_...
```

The same setup with the [Clerk CLI](https://clerk.com/docs), as it was done for this repository:

```bash
clerk apps create "OpenDots"
clerk link --app <app id>
clerk env pull          # writes both keys to .env.local
clerk enable orgs
clerk config patch --json '{"connection_oauth_microsoft":{"enabled":true},"organization_settings":{"force_organization_selection":false}}'
clerk config patch --json '{"session":{"claims":{"name":"{{user.full_name}}","image":"{{user.image_url}}","email":"{{user.primary_email_address}}"}}}'
```

Google sign-in was already on in the new application. A development instance signs in through Clerk's shared Google and Microsoft credentials; a production instance needs your own.

### Who can do what

| | Admin who is an operator | Admin | Member |
| --- | --- | --- | --- |
| Chat with any bot, create bots, upload documents, make share links | ✓ | ✓ | ✓ |
| Turn on Files, Terminal, Skills or Browser for a bot | ✓ | Can turn them off, not on | Can turn them off, not on |
| Show a bot's browser window | ✓ | – | – |
| Delete a bot, every bot, or a document | ✓ | ✓ | – |

Starter bots come with Files, Skills and Browser only in local mode and in an operator's personal workspace. Everywhere else they start without them, and an operator who is an admin there turns on what's needed. Removing someone from `OPENDOTS_OPERATORS` stops them granting more, but the bots they already gave these tools keep them until an operator turns them off.

### What happens to data from before sign-in

The first operator to sign in to their personal workspace takes over the bots, chats and documents made in local mode, once, including what they sent and read there. Later sign-ins start fresh, and anything made in local mode after that stays local. With no operator listed, nobody takes it over.

### Share links

Share links work as before: a link and a passcode, no account. A visitor's messages show as "Visitor", and the bot withholds Files, Terminal, Skills and Browser for their turns.

### Deleting people and teams

OpenDots doesn't hear about deletions in Clerk. A person or team deleted there leaves its bots, chats and documents in OpenDots's database, out of everyone's reach. To remove them, have an admin delete the bots and documents before deleting the team.

### Serving beyond this machine

With sign-in on, operators listed and sign-ups restricted, set `OPENDOTS_LISTEN_HOST` (for example `0.0.0.0`) and run `pnpm start`. Requests must still be addressed to a name OpenDots answers to, so add yours to `OPENDOTS_ALLOWED_HOSTS`, and serve it over HTTPS through a reverse proxy. Without sign-in, `pnpm start` refuses any address but loopback.

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
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | – | Clerk publishable key; with `CLERK_SECRET_KEY`, turns sign-in on |
| `CLERK_SECRET_KEY` | – | Clerk secret key; never sent to the browser or to a bot |
| `OPENDOTS_OPERATORS` | – | Comma-separated Clerk user ids allowed to give bots Files, Terminal, Skills or Browser, and to take over local data |
| `OPENDOTS_LISTEN_HOST` | `127.0.0.1` | Address `pnpm start` listens on; anything but loopback needs sign-in |
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

This starts OpenDots, reachable only from `127.0.0.1:3000`, and a Postgres server with pgvector that only the app can reach. The app finds Ollama on your machine at `host.docker.internal:11434`. On Linux, Ollama listens on `127.0.0.1` by default, which a container can't reach: start it with `OLLAMA_HOST=0.0.0.0 ollama serve`, and note that this also exposes Ollama to your local network. To use Claude, export `ANTHROPIC_API_KEY` in your shell first; to turn on [sign-in](#sign-in-and-workspaces), export the two Clerk keys and `OPENDOTS_OPERATORS` too. Publish the port beyond `127.0.0.1` only with sign-in on, operators listed and sign-ups restricted (change `ports` in `docker-compose.yml`, and list your host name in `OPENDOTS_ALLOWED_HOSTS`). The image has no browser, so the Browser tool works only when you run OpenDots on the host with `pnpm dev` or `pnpm start`.

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

Only one process at a time can open the embedded database. Stop the app before you run `pnpm db:init` against it, and don't run `pnpm dev` and `pnpm start` side by side on the same data directory. `pnpm db:init` refuses to run while the app holds the database, and a second server keeps running but its database requests fail; its `/api/health` reports 503 and names the process that holds the database.

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

- Images and files in chat
- A bot team: bots that message each other, ask each other for help, create new bots for you, and share group chats
- Graph memory: people, companies and decisions remembered across chats
- Workflow graphs: multi-step jobs you can see and edit

## Known limitations

- Sign-in is optional; without it, OpenDots is local only.
- The browser isn't sandboxed, and the container image has no browser.
- The file guard checks each path before a tool runs; it is not an operating-system sandbox, so a symlink swapped in between the check and the file operation is not caught.
- For a recursive Glob or Grep the guard checks the starting folder only; a symlink planted inside the workspace could be followed by the search.
- Captured browser frames accumulate until their bot is deleted.
- Document search is lexical, so it misses paraphrases.
- Local models must support tool calling, and answer quality depends on the model.

## License

[MIT](LICENSE)
