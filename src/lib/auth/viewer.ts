import { DEFAULT_BROWSER, HOST_TOOLS, type AssistantConfig, type ToolName } from '../domain/assistant'
import { RepositoryError, type Scope } from '../repository/chat-repository'

/**
 * Who is acting, and in which workspace.
 *
 * With Clerk configured, a viewer is read from the session on every request:
 * the user, the active organization (or none, for the personal workspace) and
 * whether they are its admin. Without Clerk, OpenDots is single-user and local,
 * and every request is the same local viewer. Pure: safe in the browser too.
 *
 * Operators are the people who run this server, listed by Clerk user id in
 * OPENDOTS_OPERATORS. Only they can give a bot a tool that reaches the server
 * itself (Files, Terminal, Skills, Browser): a shell in any workspace reaches
 * every workspace, the database and the keys, so being some workspace's admin
 * is not enough when anyone can sign up.
 */

export type Role = 'admin' | 'member'

export interface Viewer {
  userId: string
  /** Display name at the time of the request; a message keeps the one it was sent with. */
  name: string
  imageUrl: string | null
  /** A Clerk organization id, the user's own id for their personal workspace, or `local`. */
  workspaceId: string
  role: Role
  /** Listed in OPENDOTS_OPERATORS (always true in local mode): may grant host-reaching tools. */
  operator: boolean
}

export const LOCAL_WORKSPACE = 'local'

export const LOCAL_VIEWER: Viewer = {
  userId: 'user_me',
  name: 'You',
  imageUrl: null,
  workspaceId: LOCAL_WORKSPACE,
  role: 'admin',
  operator: true,
}

/** Sign-in is on only when both Clerk keys are set; half a configuration stays local. */
export function authMode(env: Partial<NodeJS.ProcessEnv> = process.env): 'clerk' | 'local' {
  return env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && env.CLERK_SECRET_KEY ? 'clerk' : 'local'
}

/** OPENDOTS_OPERATORS: comma-separated Clerk user ids (`user_…`). Unset, nobody is an operator. */
export function operatorIds(env: Partial<NodeJS.ProcessEnv> = process.env): string[] {
  return (env.OPENDOTS_OPERATORS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
}

/** What a request's Clerk session says, already reduced to plain values. */
export interface AuthFacts {
  userId: string | null
  orgId: string | null
  isOrgAdmin: boolean
  /** Session token claims; OpenDots configures `name`, `image` and `email`. */
  claims: Record<string, unknown> | null
}

function claim(claims: Record<string, unknown> | null, key: string): string | null {
  const value = claims?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function viewerFromAuth(facts: AuthFacts, operators: readonly string[] = []): Viewer | null {
  if (!facts.userId) return null
  const operator = operators.includes(facts.userId)
  // {{user.full_name}} renders as "" for someone who never set a name.
  const email = claim(facts.claims, 'email')
  const name = claim(facts.claims, 'name') ?? (email ? email.split('@')[0]! : 'Someone')
  const imageUrl = claim(facts.claims, 'image')
  if (!facts.orgId) {
    return { userId: facts.userId, name, imageUrl, workspaceId: facts.userId, role: 'admin', operator }
  }
  return { userId: facts.userId, name, imageUrl, workspaceId: facts.orgId, role: facts.isOrgAdmin ? 'admin' : 'member', operator }
}

/** The repository scope a viewer acts in: their workspace, as themselves. */
export function scopeFor(viewer: Viewer): Scope {
  return { workspaceId: viewer.workspaceId, actor: { userId: viewer.userId, name: viewer.name, operator: viewer.operator } }
}

export function isHostTool(tool: ToolName): boolean {
  return HOST_TOOLS.includes(tool)
}

export const AdminOnly = (detail: string) => new RepositoryError(detail, 403, 'ADMIN_ONLY')

/** Deleting bots or documents is for workspace admins. */
export function assertAdmin(viewer: Viewer, action: string): void {
  if (viewer.role !== 'admin') throw AdminOnly(`Only workspace admins can ${action}.`)
}

/** May this person give a bot reach into the server: an admin of this workspace who is also an operator. */
export function canGrantHostTools(viewer: Pick<Viewer, 'role' | 'operator'>): boolean {
  return viewer.role === 'admin' && viewer.operator
}

/** Who may do the thing a refusal is about, in the words the UI and the API both use. */
export function hostGrantRefusal(viewer: Pick<Viewer, 'role' | 'operator'>): string {
  return viewer.role === 'admin' ? "Only this server's operators" : 'Only workspace admins who operate this server'
}

/** Opening a bot's browser window on the server's screen reaches the host too. */
export function assertHostGrant(viewer: Viewer, action: string): void {
  if (!canGrantHostTools(viewer)) throw AdminOnly(`${hostGrantRefusal(viewer)} can ${action}.`)
}

/**
 * Anyone may keep or remove a bot's host-reaching tools; only an admin who is
 * an operator may add one. Whoever grants Terminal or Files vouches for every
 * turn that bot takes, whoever sends it. A new bot counts as adding every tool
 * it starts with.
 */
export function assertToolChange(viewer: Viewer, before: readonly ToolName[], after: readonly ToolName[]): void {
  if (canGrantHostTools(viewer)) return
  const added = after.filter((tool) => isHostTool(tool) && !before.includes(tool))
  if (added.length > 0) {
    throw AdminOnly(`${hostGrantRefusal(viewer)} can turn on ${added.join(', ')}.`)
  }
}

/**
 * The whole of the limits on creating (`before` null) or editing a bot: no new
 * host-reaching tool, and no opening its browser as a window on the server's
 * screen without the right to grant host tools — an edit must not be a way
 * around the browser switch. Closing the window, like removing a tool, is fine.
 */
export function assertConfigChange(viewer: Viewer, before: AssistantConfig | null, after: AssistantConfig): void {
  assertToolChange(viewer, before?.tools ?? [], after.tools)
  if (canGrantHostTools(viewer)) return
  if (after.browser.headed && !(before?.browser.headed ?? DEFAULT_BROWSER.headed)) {
    throw AdminOnly(`${hostGrantRefusal(viewer)} can show a bot's browser window.`)
  }
}

/** The UI's mirror of assertToolChange: may this checkbox change, given whether the tool is on now? */
export function canToggleTool(viewer: Pick<Viewer, 'role' | 'operator'>, tool: ToolName, onNow: boolean): boolean {
  return canGrantHostTools(viewer) || !isHostTool(tool) || onNow
}
