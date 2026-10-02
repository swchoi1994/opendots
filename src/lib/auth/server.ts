import { getRepository } from '../repository'
import { LOCAL_VIEWER, authMode, viewerFromAuth, type AuthFacts, type Viewer } from './viewer'

/**
 * The request's viewer, on the server.
 *
 * Local mode never touches Clerk (it is not even loaded). In Clerk mode the
 * session comes from `auth()`, which `clerkMiddleware` in the proxy makes
 * available; protection happens here, per route, as Clerk recommends, rather
 * than through route matchers in the proxy.
 */

export class Unauthenticated extends Error {
  readonly status = 401
  readonly code = 'UNAUTHENTICATED'
  constructor() {
    super('Sign in to use OpenDots.')
    this.name = 'Unauthenticated'
  }
}

type AuthSource = () => Promise<AuthFacts>

async function clerkAuth(): Promise<AuthFacts> {
  const { auth } = await import('@clerk/nextjs/server')
  const { userId, orgId, has, sessionClaims } = await auth()
  return {
    userId: userId ?? null,
    orgId: orgId ?? null,
    isOrgAdmin: Boolean(orgId) && has({ role: 'org:admin' }),
    claims: (sessionClaims as Record<string, unknown> | null) ?? null,
  }
}

// Process-wide, so tests that swap it reset it in afterEach and must not run concurrently.
let authSource: AuthSource = clerkAuth

/** Tests replace Clerk with a fake session; null restores it. Production never calls this. */
export function setAuthSourceForTests(source: AuthSource | null): void {
  authSource = source ?? clerkAuth
}

/**
 * The first personal sign-in takes over what was made before sign-in was
 * turned on (spec §9). The store makes it happen once for the whole instance;
 * this promise only saves every later request from asking again. Concurrent
 * first requests share it, and a failed attempt is forgotten so the next
 * request retries.
 */
let claimed: Promise<void> | null = null

function claimLocalDataOnce(userId: string): Promise<void> {
  claimed ??= getRepository()
    .claimLocalData(userId)
    .then(
      () => undefined,
      (error: unknown) => {
        claimed = null
        throw error
      },
    )
  return claimed
}

export async function getViewer(env: Partial<NodeJS.ProcessEnv> = process.env): Promise<Viewer | null> {
  if (authMode(env) === 'local') return LOCAL_VIEWER
  const viewer = viewerFromAuth(await authSource())
  // Only a personal workspace claims: data made alone shouldn't land in a team.
  if (viewer && viewer.workspaceId === viewer.userId) await claimLocalDataOnce(viewer.userId)
  return viewer
}

export async function requireViewer(env: Partial<NodeJS.ProcessEnv> = process.env): Promise<Viewer> {
  const viewer = await getViewer(env)
  if (!viewer) throw new Unauthenticated()
  return viewer
}
