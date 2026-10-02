import { DEFAULT_BROWSER, HOST_TOOLS, type AssistantConfig, type ToolName } from '../domain/assistant'
import { RepositoryError, type Scope } from '../repository/chat-repository'

/**
 * Who is acting, and in which workspace.
 *
 * With Clerk configured, a viewer is read from the session on every request:
 * the user, the active organization (or none, for the personal workspace) and
 * whether they are its admin. Without Clerk, OpenDots is single-user and local,
 * and every request is the same local viewer. Pure: safe in the browser too.
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
}

export const LOCAL_WORKSPACE = 'local'

export const LOCAL_VIEWER: Viewer = {
  userId: 'user_me',
  name: 'You',
  imageUrl: null,
  workspaceId: LOCAL_WORKSPACE,
  role: 'admin',
}

/** Sign-in is on only when both Clerk keys are set; half a configuration stays local. */
export function authMode(env: Partial<NodeJS.ProcessEnv> = process.env): 'clerk' | 'local' {
  return env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && env.CLERK_SECRET_KEY ? 'clerk' : 'local'
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

export function viewerFromAuth(facts: AuthFacts): Viewer | null {
  if (!facts.userId) return null
  // {{user.full_name}} renders as "" for someone who never set a name.
  const email = claim(facts.claims, 'email')
  const name = claim(facts.claims, 'name') ?? (email ? email.split('@')[0]! : 'Someone')
  const imageUrl = claim(facts.claims, 'image')
  if (!facts.orgId) {
    return { userId: facts.userId, name, imageUrl, workspaceId: facts.userId, role: 'admin' }
  }
  return { userId: facts.userId, name, imageUrl, workspaceId: facts.orgId, role: facts.isOrgAdmin ? 'admin' : 'member' }
}

/** The repository scope a viewer acts in: their workspace, as themselves. */
export function scopeFor(viewer: Viewer): Scope {
  return { workspaceId: viewer.workspaceId, actor: { userId: viewer.userId, name: viewer.name } }
}

export function isHostTool(tool: ToolName): boolean {
  return HOST_TOOLS.includes(tool)
}

export const AdminOnly = (detail: string) => new RepositoryError(detail, 403, 'ADMIN_ONLY')

/** Deleting bots or documents and showing a bot's browser window are for workspace admins. */
export function assertAdmin(viewer: Viewer, action: string): void {
  if (viewer.role !== 'admin') throw AdminOnly(`Only workspace admins can ${action}.`)
}

/**
 * A member may keep or remove a bot's host-reaching tools but never add one:
 * whoever grants Terminal or Files vouches for every turn that bot takes, so
 * only workspace admins can. A new bot counts as adding every tool it starts with.
 */
export function assertToolChange(viewer: Viewer, before: readonly ToolName[], after: readonly ToolName[]): void {
  if (viewer.role === 'admin') return
  const added = after.filter((tool) => isHostTool(tool) && !before.includes(tool))
  if (added.length > 0) {
    throw AdminOnly(`Only workspace admins can turn on ${added.join(', ')}.`)
  }
}

/**
 * The whole of a member's limits on creating (`before` null) or editing a bot:
 * no new host-reaching tool, and no opening its browser as a window on the
 * server's screen — that is the admin-only browser switch, and an edit must
 * not be a way around it. Closing the window, like removing a tool, is fine.
 */
export function assertConfigChange(viewer: Viewer, before: AssistantConfig | null, after: AssistantConfig): void {
  assertToolChange(viewer, before?.tools ?? [], after.tools)
  if (viewer.role === 'admin') return
  if (after.browser.headed && !(before?.browser.headed ?? DEFAULT_BROWSER.headed)) {
    throw AdminOnly("Only workspace admins can show a bot's browser window.")
  }
}

/** The UI's mirror of assertToolChange: may this checkbox change, given whether the tool is on now? */
export function canToggleTool(role: Role, tool: ToolName, onNow: boolean): boolean {
  return role === 'admin' || !isHostTool(tool) || onNow
}
