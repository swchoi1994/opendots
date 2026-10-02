# OpenDots B: Sign-in and workspaces

**Date:** 2026-10-02
**Status:** Design approved in chat.
**Roadmap:** [2026-10-01-opendots-roadmap.md](2026-10-01-opendots-roadmap.md), sub-project B of six. Builds on A (`docs/specs/2026-10-01-opendots-core-design.md`, merged as `c1d9921`).

## 1. Goal

People sign in with Google or Microsoft (through Clerk) and work in workspaces:
- a **personal** workspace for each person;
- **team** workspaces (Clerk Organizations) shared with members.

Bots, chats and knowledge documents belong to a workspace. With Clerk left unconfigured, OpenDots keeps working exactly as in A: single user, local only.

### Non-goals

- Group chats with people and bots together (F).
- Clerk webhooks and data deletion sync.
- Billing.
- A Clerk production instance.
- Docker changes beyond documentation.
- Per-bot sharing inside a workspace (everyone in a workspace sees all its bots).

## 2. Decisions taken in chat (2026-10-02)

| Question | Decision |
| --- | --- |
| Clerk application | A new development application, **OpenDots**, created with the Clerk CLI. Keys live only in `.env.local`. |
| Who may grant host-reaching tools in a team workspace | **Workspace admins only** (Clerk role `org:admin`). In a personal workspace the owner is the admin. |
| Local-mode data when sign-in is turned on | **The first person to sign in claims it**, into their personal workspace, exactly once. |
| Share links with sign-in on | **Kept as they are.** Link plus passcode, no account needed, and visitors never get host-reaching tools. |
| Approach | **Clerk-native workspaces with a scoped store.** No local tables of users or memberships, and no webhooks. |

## 3. Verified premises (2026-10-02, this Mac)

| Premise | Evidence |
| --- | --- |
| Clerk CLI is signed in as the owner and can manage the instance | `clerk whoami` printed the owner's account; `clerk apps create "OpenDots"` created the app; `clerk link` and `clerk env pull` wrote `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` to the git-ignored `.env.local` |
| Instance configuration | Through `clerk enable orgs` and `clerk config patch`: Google on; Microsoft on (Clerk's shared development credentials); Organizations on, with `creator_role: org:admin` and `force_organization_selection: false` (personal accounts allowed); session token claims `name: {{user.full_name}}` and `image: {{user.image_url}}`; password sign-in on (min length 15, breached-password check); email-code sign-in on |
| Package compatibility | `@clerk/nextjs` 7.9.10 has `peerDependencies.next` `^16.1.0-0`, which covers our 16.2.12 |
| Recommended protection pattern | Clerk docs: protecting through `createRouteMatcher()` in middleware is being deprecated; protect each page and route handler with `auth()` (`isAuthenticated`, `redirectToSignIn()`, `has({ role })`). `auth.protect()` returns 404 for route handlers, so route handlers return their own 401. |
| Test sign-ins without a real inbox | Clerk development instances accept the code `424242` for addresses containing `+clerk_test` |

## 4. Modes

`authMode()` returns `'clerk'` when both `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` are set, and `'local'` otherwise. It's read on every call, never cached at module load, so tests can flip it.

- **Local mode** behaves as in A: no sign-in, server bound to 127.0.0.1, one implicit viewer.
- **Clerk mode** requires sign-in everywhere except the public routes in §7.

## 5. The viewer

```ts
export interface Viewer {
  userId: string            // Clerk user id, or 'user_me' in local mode
  name: string              // display name at the time of the request
  imageUrl: string | null
  workspaceId: string       // Clerk org id, the user's own id for the personal workspace, or 'local'
  role: 'admin' | 'member'
}
```

`viewerFromAuth(auth)` is a pure function over `{ userId, orgId, isAdmin, claims }`:
- A personal workspace is the user's own id, with role `admin`.
- An organization is `orgId`, with role `admin` when `has({ role: 'org:admin' })`, otherwise `member`.
- The name comes from the `name` claim. Clerk renders an unset full name as an empty string, so the name falls back to the local part of the `email` claim, then to "Someone"; a raw user id is never shown. The picture comes from the `image` claim, or `null`.

`getViewer()` (server-only) returns the local viewer in local mode. In Clerk mode it calls `auth()` and returns `null` when the visitor isn't signed in. It doesn't call `currentUser()`: the session claims carry name and picture.

## 6. Data

Migration `db/005_workspaces.sql`:
- `channels.workspace_id TEXT NOT NULL DEFAULT 'local'`, indexed;
- `skills.workspace_id TEXT NOT NULL DEFAULT 'local'`;
- a table `instance_claims (name TEXT PRIMARY KEY, value TEXT NOT NULL, claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`.

Rows that exist today stay in `local`. Messages, read receipts, sessions, screens and deployments hang off a channel, so they follow its workspace. Messages already store `sender_id` and `sender_name`; read receipts already store `user_id`.

**Repository scope.** A repository instance is bound to a `Scope = { workspaceId: string; actor: { userId: string; name: string } }`: `getRepository(scope)` builds one per request, and `LOCAL_SCOPE` (`local`, `user_me`/"You") is the default. Method signatures don't change:
- **Listing:** `listChannels`, `listSkills` and `listSkillIds` return only the scope's workspace.
- **Creating:** `createChannel` and `createSkill` create in the scope's workspace.
- **Every method naming a channel or skill:** a channel or skill outside the workspace is reported exactly like a missing one (`CHANNEL_NOT_FOUND` / `SKILL_NOT_FOUND`, 404). Nothing reveals that another workspace's channel exists.
- **Identity:** `sendMessage` records `scope.actor` as the sender, and read receipts are per `scope.actor.userId`. A person with no receipt in a channel has every message they didn't send unread.
- **Seeding:** the nine starter bots are seeded per workspace, the first time in a process that `listChannels` finds the workspace empty; deleting a bot or all bots lets the next listing look again. If any of a workspace's seed URLs is already taken, it gets no starter bots at all (after a claim, the claimed bots keep `local`'s URLs, so a later `local` listing finds them taken). Starter bots keep their default tools where the person seeding owns the workspace alone (`local`, or their personal workspace); in an organization they start without host-reaching tools (§8). Seeded channel URLs are `bot_<slug>` in `local` (A's URLs, unchanged) and `bot_<slug>_<8 hex of sha256(workspaceId)>` elsewhere, because channel URLs are unique across the whole instance.
- **Turn context:** `loadTurnContext` and the respond route use the scope too, so a bot's transcript shows each person's real name.

**Share-link (deployment) routes** look the channel up by deployment id. `getDeployment` stays unscoped and its result gains the channel's `workspaceId`. They then act in that workspace with a visitor viewer, `{ userId: 'visitor_<deploymentId>', name: 'Visitor' }`, so a visitor's messages are attributed to "Visitor". The passcode check stays the gate, and visitors stay restricted (§8).

## 7. Routes, pages and the proxy

**Proxy.** In Clerk mode, `src/proxy.ts` wraps A's request guard in `clerkMiddleware(...)`, which only makes `auth()` available; protection happens per route. In local mode, the proxy is A's guard alone (`clerkMiddleware` needs the keys). `clerkMiddleware` and `<ClerkProvider>` both name `/sign-in` and `/sign-up`, so nobody is sent to Clerk's hosted pages. `next.config.ts` sets `skipProxyUrlNormalize: true`: otherwise Next gives the proxy a `localhost` URL while serving `127.0.0.1`, Clerk re-points the request at it, and Next proxies the request to itself in a loop.

**Public routes** (no sign-in, Clerk mode):
- `/sign-in/*` and `/sign-up/*`;
- `/app/*` (share-link pages) and `/api/deployments/*` (their passcode-gated API);
- `/api/health`, which with no viewer reports only `{ status, service }`.

**Every other API route** begins with `const viewer = await requireViewer()`. It returns 401 `{ error, code: 'UNAUTHENTICATED' }` when nobody is signed in. Routes without a channel use the viewer's workspace; routes with one go through the scoped repository.

**Pages.**
- `src/app/page.tsx` calls `getViewer()`. In Clerk mode with no viewer it returns `redirectToSignIn()`. Otherwise it renders `<ChatShell viewer={{ userId, name, imageUrl, role }} authMode={…} />`.
- `ChatShell` uses `viewer.userId` instead of `CURRENT_USER_ID` to decide which messages are "mine" (MessageBubble, Avatar).
- `src/app/sign-in/[[...sign-in]]/page.tsx` and `src/app/sign-up/[[...sign-up]]/page.tsx` render Clerk's `<SignIn />` and `<SignUp />`, which carry the Google and Microsoft buttons.
- In Clerk mode the root layout wraps the app in `<ClerkProvider>`.
- In Clerk mode the bot list's header shows Clerk's `<OrganizationSwitcher hidePersonal={false} />` and `<UserButton />`. Switching workspace reloads the bot list; the client re-fetches after `afterSelectOrganizationUrl="/"` and `afterSelectPersonalUrl="/"`.

## 8. Permissions

**Host-reaching tools** are `files`, `shell`, `skills` and `web_browser` (the same list A uses for share-link visitors). `canGrantHostTools(viewer) = viewer.role === 'admin'`.

On `createChannel` and `updateAssistant`, `assertToolChange(viewer, before, after)`:
- for a member, any host-reaching tool in `after` that is not in `before` returns 403 `{ code: 'ADMIN_ONLY' }`;
- removing tools is always allowed;
- for a new bot, `before` is empty.

**Also admin-only (403 for members):**
- `PATCH /api/channels/:url/browser` (showing the bot's browser window);
- deleting a bot, and deleting all bots;
- deleting a knowledge document.

**Everyone in the workspace** can chat with any bot, create bots without host-reaching tools, upload documents, and make share links.

**Running a bot.** A turn runs with the bot's stored tools, whoever sent the message. An admin who granted Terminal vouches for that bot. So no bot in an organization holds a host-reaching tool an admin didn't grant: starter bots there are seeded without them, and a stored bot with no tool list reads as having none of them.

**The UI** disables the host-reaching tool checkboxes for members, with the hint "Only workspace admins can turn this on". It's a convenience; the server rule above is the real gate.

## 9. Claiming local data

It runs from `getViewer()` in Clerk mode, whenever the viewer is in their **personal** workspace. Once a process has seen the `local_data` row, it remembers that and stops checking. `claimLocalData(userId)` runs once, in one transaction under an advisory lock:
- If `instance_claims` has no `local_data` row and any channel or skill is in `local`, move them all to `workspace_id = userId`.
- Copy the local person's (`user_me`) read receipts to `userId`, so the claimed bots don't all arrive unread.
- Insert `local_data = userId`.

Once that row exists the claim never runs again, for anyone. A claim that finds nothing in `local` still writes the row, so data created later in a local-mode session stays local. Viewers in a team workspace never trigger a claim.

The memory store implements the same rule. Its data doesn't survive a restart, which is acceptable for the tests and eval that use it.

## 10. Serving beyond localhost

`pnpm start` becomes `node scripts/start.mjs`:
- It reads `OPENDOTS_LISTEN_HOST` (default `127.0.0.1`).
- It loads the same `.env` files `next start` does (`@next/env`), so it decides the mode Next will run in.
- It refuses to start, with a clear message, if that host isn't loopback while `authMode()` is local, and it refuses `-H`/`--hostname` on its command line, which would step around that check.
- Otherwise it runs `next start -H <host>` (cross-platform: `spawn` with `process.execPath` and Next's bin).

`pnpm dev` stays on 127.0.0.1. Requests still pass A's Host check, so a public hostname must be in `OPENDOTS_ALLOWED_HOSTS`. Docker's documentation explains publishing beyond 127.0.0.1 when Clerk is configured.

## 11. Identity policy

| Question | Answer |
| --- | --- |
| Linking rule | None. The Clerk user id is the only identity; there's no matching by email and no local user rows. |
| Trust rule | Only a valid Clerk session (verified by `clerkMiddleware`/`auth()`). Claims are trusted because Clerk signs them. |
| Source of truth per field | Clerk, for name, picture and memberships. A message stores its sender's name as it was when sent. |
| Sync | None. Identity is read from the session token on every request. |
| Deletion | A user or organization deleted in Clerk leaves its OpenDots workspace data in place. Delete-sync needs a webhook and a public URL, which is out of scope. The README says so, and the operator can remove the data by hand. |

## 12. Trust boundaries

| List | Change |
| --- | --- |
| Bot subprocess environment (`baseEnv`/`brainEnv`) | Unchanged. `CLERK_SECRET_KEY` and the publishable key are not on the allowlist (a test asserts this). |
| Proxy request guard | Unchanged in local mode; in Clerk mode it runs inside `clerkMiddleware` |
| Public routes (no viewer needed) | `/sign-in/*`, `/sign-up/*`, `/app/*`, `/api/deployments/*`, `/api/health` (reduced output) |
| Host-tool grants | Admins only (§8); members may only remove |
| Share-link visitor restrictions | Unchanged |
| Listening beyond loopback | Allowed only in Clerk mode (§10) |

## 13. Testing and verification

### 13.1 Unit tests (no network, no Clerk calls)

- `viewerFromAuth`: personal workspace, organization admin, organization member, and missing claims.
- `authMode` under each combination of the two variables.
- `assertToolChange`: a member adding Terminal is refused; a member removing Terminal is allowed; an admin may do anything; a new bot made by a member with Files is refused.
- The repository contract (memory store and PGlite):
  - two workspaces never see each other's channels or skills;
  - naming another workspace's channel returns 404, the same as a missing one;
  - each workspace gets its own seeded bots, with distinct URLs;
  - messages carry the viewer as sender;
  - read receipts are per viewer.
- `claimLocalData`: it moves `local` data once, the second claimant gets nothing, and it runs only for personal workspaces.
- Route-level checks with an injected viewer: no viewer gives 401, a member's host-tool grant gives 403, and the deployment routes still work without a viewer.
- `scripts/start.mjs` host guard: local mode with a non-loopback host is refused; Clerk mode is allowed.
- `/api/health` without a viewer in Clerk mode: `{ status, service }` only.

### 13.2 Live checks (recorded in the PR)

Pre-flight: create test users with the Clerk CLI (`alice+clerk_test@…`, `bob+clerk_test@…`, passwords of at least 15 characters), and check the instance configuration with `clerk config pull`.

1. **Signed out.** `/` redirects to `/sign-in`, whose screen shows Google and Microsoft buttons. An API route returns 401. `/api/health` returns `{ status, service }` only.
2. **Alice signs in** through the browser (Playwright). She sees the nine bots in her personal workspace and claims the local data, which is visible in her workspace.
3. **Bob signs in.** He sees only his own seeded bots. Alice's channel URL returns 404 for him.
4. **A shared workspace.** Alice creates organization "Team", invites Bob as a member, and Bob accepts. Both see Team's bots. Bob can chat with them, but enabling Terminal on one returns 403, and the checkbox is disabled.
5. **Share links.** A share link to a Team bot still opens signed out, with the passcode.
6. **Back to local mode.** With the Clerk keys removed from the environment, the app runs as in A, and the data Alice claimed is not visible.
7. **Real OAuth.** One manual Google or Microsoft sign-in by the owner, recorded as observed or not observed.

## 14. Done when

- Everything in 13.1 passes in CI, and 13.2 is recorded.
- The README documents sign-in setup:
  - the two Clerk keys;
  - enabling Google and Microsoft and Organizations, and allowing personal accounts;
  - the session token claims;
  - `OPENDOTS_LISTEN_HOST`.
- A clone with no Clerk keys still passes A's local-mode checks.
- Merged through a pull request into `main`.
