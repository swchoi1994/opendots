'use client'

import { createContext, useContext } from 'react'
import { LOCAL_VIEWER, type Role } from '@/lib/auth/viewer'

/**
 * Who is looking, as the browser needs it: whose messages are "mine", whether
 * admin-only controls are offered, and whether to show Clerk's switcher. The
 * server enforces every rule; this only keeps the UI from offering what the
 * server would refuse.
 */
export interface ClientViewer {
  userId: string
  name: string
  imageUrl: string | null
  role: Role
  /** Signed in through Clerk; false in local mode and on share links. */
  clerk: boolean
}

export const LOCAL_CLIENT_VIEWER: ClientViewer = {
  userId: LOCAL_VIEWER.userId,
  name: LOCAL_VIEWER.name,
  imageUrl: LOCAL_VIEWER.imageUrl,
  role: LOCAL_VIEWER.role,
  clerk: false,
}

/** A share link's visitor, matching the server's `visitorScope`. */
export function visitorViewer(deploymentId: string): ClientViewer {
  return { userId: `visitor_${deploymentId}`, name: 'Visitor', imageUrl: null, role: 'member', clerk: false }
}

const ViewerContext = createContext<ClientViewer>(LOCAL_CLIENT_VIEWER)

export const ViewerProvider = ViewerContext.Provider

export function useViewer(): ClientViewer {
  return useContext(ViewerContext)
}
