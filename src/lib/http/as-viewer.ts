import { requireViewer } from '../auth/server'
import { scopeFor, type Viewer } from '../auth/viewer'
import { getRepository } from '../repository'
import type { ChatRepository } from '../repository/chat-repository'
import { withErrors } from './errors'

/**
 * The start of every signed-in API route: who is asking, and the store as they
 * see it — their workspace, acting as them. Nobody signed in is a 401.
 */
export function asViewer(handler: (ctx: { viewer: Viewer; repo: ChatRepository }) => Promise<Response>): Promise<Response> {
  return withErrors(async () => {
    const viewer = await requireViewer()
    return handler({ viewer, repo: getRepository(scopeFor(viewer)) })
  })
}
