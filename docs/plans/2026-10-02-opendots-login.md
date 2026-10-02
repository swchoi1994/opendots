# OpenDots B: Sign-in and workspaces — Implementation Plan

> **Execution:** the controller implements these tasks itself, test-first, and an independent reviewer subagent gates each task. During A, three implementer subagents in a row died on the 600 s stream watchdog. Every step still has a test, a review, and a commit.

**Goal:**
- Clerk sign-in with Google and Microsoft.
- Personal and team workspaces that own bots, chats and documents.
- Admin-only host-reaching tools.
- A one-time claim of local data.
- Share links unchanged.
- Local mode unchanged when Clerk isn't configured.

**Architecture:**
- **Viewer:** each request works out a `Viewer` from Clerk's `auth()`, or a fixed local viewer.
- **Scoped store:** a `Scope` (`workspaceId` plus the acting person) is bound into a repository instance: `getRepository(scope)`. Every store query filters by the workspace, so routes keep their method calls.
- **Proxy:** `clerkMiddleware` wraps A's request guard only in Clerk mode. Protection lives in each route (Clerk's recommended pattern).

**Tech stack:** `@clerk/nextjs` 7.9.10 on Next 16.2.12; PGlite/Postgres; node:test via tsx.

**Spec:** `docs/specs/2026-10-02-opendots-login-design.md`

## Global Constraints

- Branch `feat/login`; merged through a pull request into `main`.
- Code style as in A: 2-space indent, no semicolons, single quotes, `node:` imports, and comments that explain why.
- Unit tests make no network calls and never call Clerk; Clerk is reached only through an injected `auth` function.
- `pnpm test` keeps running with `--env-file=scripts/test.env` (`DATA_STORE=memory`). Clerk keys are **unset** in tests unless a test sets them itself.
- With no Clerk keys, everything in A's verification still holds: local mode is the default.
- `CLERK_SECRET_KEY` must never reach a bot's process, and no `NEXT_PUBLIC_*` variable may hold a secret.
- Channel or skill outside the viewer's workspace = the same 404 as a missing one (`CHANNEL_NOT_FOUND` / `SKILL_NOT_FOUND`).
- Host-reaching tools: `files`, `shell`, `skills`, `web_browser` (A's `VISITOR_RESTRICTED_TOOLS`).
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Gates run bare, never piped: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm eval`, `pnpm build`.

## Interfaces fixed up front

```ts
// src/lib/auth/viewer.ts (pure)
export type Role = 'admin' | 'member'
export interface Viewer { userId: string; name: string; imageUrl: string | null; workspaceId: string; role: Role }
export const LOCAL_WORKSPACE = 'local'
export const LOCAL_VIEWER: Viewer  // { userId: 'user_me', name: 'You', imageUrl: null, workspaceId: 'local', role: 'admin' }
export function authMode(env?: Partial<NodeJS.ProcessEnv>): 'clerk' | 'local'
export interface AuthFacts { userId: string | null; orgId: string | null; isOrgAdmin: boolean; claims: Record<string, unknown> | null }
export function viewerFromAuth(facts: AuthFacts): Viewer | null
export function isHostTool(tool: ToolName): boolean
export function assertToolChange(viewer: Viewer, before: readonly ToolName[], after: readonly ToolName[]): void  // throws RepositoryError 403 ADMIN_ONLY

// src/lib/auth/server.ts (server only)
export async function getViewer(deps?: { auth?: () => Promise<AuthFacts>; env?: Partial<NodeJS.ProcessEnv> }): Promise<Viewer | null>
export async function requireViewer(...): Promise<Viewer>  // throws Unauthenticated (401)
export function scopeFor(viewer: Viewer): Scope

// src/lib/repository/chat-repository.ts
export interface Scope { workspaceId: string; actor: { userId: string; name: string } }
export const LOCAL_SCOPE: Scope
// ChatRepository methods unchanged in shape; instances are bound to a Scope.
// Deployment gains workspaceId. New instance-level method:
claimLocalData(userId: string): Promise<'claimed' | 'already'>

// src/lib/repository/index.ts
export function getRepository(scope?: Scope): ChatRepository  // default LOCAL_SCOPE
```

---

### Task 1: Auth mode, the viewer, and host-tool policy (pure modules + server helpers)

**Files:**
- Create: `src/lib/auth/viewer.ts` and `.test.ts`; `src/lib/auth/server.ts` and `.test.ts`.
- Modify: `package.json` (add `@clerk/nextjs@7.9.10`).

**Tests first.**
- `authMode`: local when neither key is set or only one is; clerk when both are.
- `viewerFromAuth`:
  - no `userId` gives `null`;
  - no `orgId` gives the personal workspace, `workspaceId = userId`, role `admin`;
  - an `orgId` with `isOrgAdmin` gives that workspace with role `admin`;
  - an `orgId` without it gives role `member`;
  - the name comes from claims and falls back to `userId`; the picture comes from claims or is `null`;
  - blank or non-string claims are ignored.
- `assertToolChange`:
  - admin: anything goes;
  - member: adding `shell` throws `ADMIN_ONLY`, removing it is fine, adding `rag_search` is fine;
  - a member creating a bot (`before` empty) with `files` throws.
- `getViewer`:
  - local mode returns `LOCAL_VIEWER` without calling `auth`;
  - Clerk mode calls the injected `auth` and maps it;
  - Clerk mode with nobody signed in returns `null`.
- `requireViewer` throws `Unauthenticated` (status 401, code `UNAUTHENTICATED`).

**Implementation.**
- The default `auth` in `server.ts` imports `auth` from `@clerk/nextjs/server` lazily (`await import`), so local mode never loads Clerk.
- It maps `{ userId, orgId, has, sessionClaims }` to `AuthFacts` with `isOrgAdmin = Boolean(orgId) && has({ role: 'org:admin' })`.

Commit: `feat(auth): auth mode, viewer and host-tool policy`.

### Task 2: Workspace-scoped storage

**Files:**
- Create: `db/005_workspaces.sql`.
- Modify:
  - `src/lib/repository/chat-repository.ts`: add `Scope`, `LOCAL_SCOPE`, `Deployment.workspaceId`, `claimLocalData`;
  - `memory-store.ts`: factory `createMemoryRepository(scope)`; `memoryRepository = createMemoryRepository(LOCAL_SCOPE)`;
  - `postgres-store.ts`: constructor `(db?, scope = LOCAL_SCOPE)`;
  - `repository/index.ts`: `getRepository(scope)`;
  - `contract.ts`: the factory takes a scope;
  - `memory-store.test.ts` and `postgres-store.test.ts`;
  - `src/lib/domain/seed.ts`: `seedChannelUrl(slug, workspaceId)`; `buildSeed(scope)`.

**Migration `005_workspaces.sql`.**

```sql
ALTER TABLE channels ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'local';
CREATE INDEX IF NOT EXISTS channels_workspace_idx ON channels (workspace_id);
ALTER TABLE skills ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'local';
CREATE INDEX IF NOT EXISTS skills_workspace_idx ON skills (workspace_id);
CREATE TABLE IF NOT EXISTS instance_claims (
  name       TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Contract tests (both stores).** These are new, and the existing seven tests run with `LOCAL_SCOPE`.
- Workspace A's channels and skills are invisible to workspace B: list excludes them, `getChannel` gives `null`, `listMessages` gives `null`, and `sendMessage`, `updateAssistant`, `deleteChannel` and `deployChannel` throw `CHANNEL_NOT_FOUND`.
- Each workspace is seeded with 9 bots. URLs are `bot_<slug>` in `local` and `bot_<slug>_<8hex>` elsewhere, and two workspaces get distinct URLs.
- `sendMessage` records `scope.actor` (`userId`, `name`) as the sender.
- Read receipts and unread counts are per actor: Bob's unread count is unaffected by Alice reading.
- `getDeployment` returns the channel's `workspaceId`.
- `deleteAllChannels` removes only the scope's workspace.
- `claimLocalData('user_a')`, run as a non-local scope:
  - moves every `local` channel and skill to `user_a` and returns `claimed`;
  - a second call by `user_b` returns `already` and moves nothing;
  - channels created in `local` after the claim stay in `local`.

**Postgres implementation notes.**
- `requireChannel(url)` becomes `SELECT … FROM channels WHERE channel_url = $1 AND workspace_id = $2`. Every method that takes a channel URL calls it first, and `getChannel` and `listMessages` return `null` on a miss.
- `CHANNEL_SELECT` gains `WHERE c.workspace_id = $2`. The `me.userId` parameters become `this.scope.actor.userId`, and sender inserts use `this.scope.actor`.
- `userFor` returns the stored `sender_id`/`sender_name` for humans.
- Seeding moves under `pg_advisory_xact_lock(hashtext('opendots_seed:' || workspace_id))`, keyed per workspace, with `this.seeded` a Set of workspaces.
- `claimLocalData` runs in one transaction with `pg_advisory_xact_lock(hashtext('opendots_claim'))`. If there's no `instance_claims` row named `local_data`, it updates channels and skills from `local` to `userId` and inserts the row.

**Memory implementation notes.**
- `GroupChannel` gains `workspaceId`; skills are kept with a `workspaceId`.
- The store holds `claims: Map<string, string>`.
- Seeding happens per workspace on first `listChannels`.
- `toSummary(channel, actorId)` computes `unreadMessageCount` from the actor's receipt. Members are `[actorUser, bot]`.
- `STORE_VERSION` goes to 8.

Commit: `feat(store): workspace-scoped repositories, per-workspace seeds, one-time local claim`.

### Task 3: Routes, turns and the tool-grant policy

**Files:**
- Modify every route under `src/app/api/channels/**`, `src/app/api/skills/**`, `src/app/api/rag/search`, and `src/app/api/models`. Each begins `const viewer = await requireViewer()` and maps `Unauthenticated` to 401, then calls `getRepository(scopeFor(viewer))`.
- `POST /api/channels` and `PATCH /api/channels/:url` call `assertToolChange(viewer, before, after.tools)` and map it to 403.
- `PATCH /browser`, `DELETE /api/channels/:url`, `DELETE /api/channels` and `DELETE /api/skills/:id` are admin-only: 403 `ADMIN_ONLY` for members.
- The deployment routes and `src/app/app/[deploymentId]/page.tsx` call `getRepository()`, which is unscoped, only for `getDeployment`. Then `getRepository({ workspaceId: deployment.workspaceId, actor: { userId: 'visitor_' + id, name: 'Visitor' } })`.
- `src/lib/ai/respond-stream.ts`, `run-bot-turn.ts` (`loadTurnContext(channelUrl, trigger, scope)`, `runBotTurn(ctx…)` with `ctx.scope`) and `src/lib/ai/rag/retriever.ts` (the repository parameter) pass the scope through. The transcript uses each sender's stored name.
- `src/lib/eval/run.ts` uses `getRepository(LOCAL_SCOPE)` explicitly.
- `src/lib/health.ts` and `/api/health`: with Clerk mode on and no viewer, `{ status, service }` only. With a viewer, as in A, scoped to the viewer's workspace.
- A shared helper, `src/lib/http/errors.ts`, turns `Unauthenticated` and `RepositoryError` into JSON responses, so routes don't repeat the mapping.

**Tests:**
- `run-bot-turn.test.ts`: the transcript uses the sender names.
- New route-level tests, which call the route handlers with an injected viewer through `setAuthSourceForTests(fn)` exported from `src/lib/auth/server.ts`. Production never calls it, and node's test runner doesn't set `NODE_ENV`, so there's no environment check:
  - no viewer gives 401;
  - a member adding `shell` gives 403;
  - a member deleting a bot gives 403;
  - deployment routes work with no viewer.

Commit: `feat(api): every route acts as the signed-in viewer in their workspace; admins grant host tools`.

### Task 4: UI, proxy and pages

**Files:**
- **`src/proxy.ts`:** with `authMode() === 'clerk'`, export `clerkMiddleware(guarded)`; otherwise `guarded` (A's guard). The matcher also covers `'/__clerk/(.*)'`.
- **`src/app/layout.tsx`:** wrap in `<ClerkProvider>` when in Clerk mode.
- **`src/app/sign-in/[[...sign-in]]/page.tsx`** and **`sign-up/[[...sign-up]]/page.tsx`:** centred `<SignIn />` / `<SignUp />`; in local mode, redirect to `/`.
- **`src/app/page.tsx`:** in Clerk mode with no viewer, `redirectToSignIn()`; render `<ChatShell viewer={…} clerk={mode === 'clerk'} />`.
- **`src/components/ViewerContext.tsx`:** React context `{ userId, name, imageUrl, role, clerk }`. ChatShell provides it; DeployedChat provides a visitor viewer, `visitor_<id>`.
- **`MessageBubble` and `Avatar`:** "own" is `sender.userId === viewer.userId`. Avatar treats the bot member as the one whose `userId` starts with `bot_`.
- **`BotList` footer:** in Clerk mode, `<OrganizationSwitcher hidePersonal={false} afterSelectOrganizationUrl="/" afterSelectPersonalUrl="/" />` and `<UserButton />`; in local mode, "You" as today.
- **`NewBotDialog` and `BotPanel`:** for members, host-tool checkboxes are disabled and titled "Only workspace admins can turn this on". Show the server's 403 error text when it occurs. Hide delete for members.
- **`useChat`:** on 401, redirect to `/sign-in`.

**Tests:** a pure helper `canToggleTool(role, tool, checked)` with unit tests. Proxy selection is a pure `chooseProxy(mode)` test.

Commit: `feat(ui): sign-in pages, workspace switcher, viewer-aware chat, admin-only tool toggles`.

### Task 5: Serving beyond localhost, and docs

**Files:**
- **`scripts/start.mjs`:** export `startArgs(env)` for tests, and run `next start -H <host>` via `spawn(process.execPath, [nextBin, 'start', '-H', host])`. A non-loopback host in local mode exits 1 with a message.
- **Test:** `scripts/start.test.mjs`, picked up through a `test` glob addition `"scripts/**/*.test.mjs"`.
- **`package.json`:** `"start": "node scripts/start.mjs"`.
- **README:**
  - a "Sign-in and workspaces" section covering the Clerk app, keys, Google and Microsoft, Organizations with personal accounts allowed, and session claims `name`/`image`, with the `clerk` CLI commands used here as a recipe;
  - roles and what admins can do;
  - the one-time claim;
  - share links;
  - deletion behaviour;
  - `OPENDOTS_LISTEN_HOST`;
  - the configuration table gains `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` and `OPENDOTS_LISTEN_HOST`;
  - the Known-limitations line "No sign-in yet" goes, replaced by "Sign-in is optional; without it, local only".
- **`.env.example`:** the Clerk keys (commented out).
- **`docker-compose.yml`:** pass the Clerk keys through, with a comment on publishing beyond 127.0.0.1 only when Clerk is on.
- **Spec amendments** for anything decided during the build.

**Verification:** every README variable is read somewhere (A's grep loop), and the §8 grep is clean.

Commit: `docs: sign-in setup, roles, claim, serving beyond localhost`.

### Task 6: Live verification and merge (controller)

Spec §13.2, recorded as observed / not observed / failed:
- **Pre-flight:** `clerk users create` for `alice+clerk_test@example.com` and `bob+clerk_test@example.com` (passwords of at least 15 characters), and `clerk config pull` to check Google, Microsoft, Organizations and claims.
- **Run:** a fresh clone on port 3130 with `.env.local` Clerk keys and a scratch `OPENDOTS_DATA_DIR`, driven through Playwright. Sign in with email code `424242` or a password.
- **Steps 1–6** as in the spec; step 7 (real OAuth) asks the owner.
- **Then:** the PR, CI, a whole-branch review on the most capable model, one fix wave and a scoped re-review, then merge. Verify the merged `main`.
