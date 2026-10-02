import { connection } from 'next/server'
import { ChatShell } from '@/components/ChatShell'
import { getViewer } from '@/lib/auth/server'
import { authMode } from '@/lib/auth/viewer'

export default async function Home() {
  // Per request: whether sign-in is on, and who is looking, come from the
  // running server's environment and session, never from the build.
  await connection()
  const viewer = await getViewer()
  if (!viewer) {
    const { auth } = await import('@clerk/nextjs/server')
    return (await auth()).redirectToSignIn()
  }
  return (
    <ChatShell
      // Switching workspace reloads this page; a new key starts the chat state over.
      key={viewer.workspaceId}
      viewer={{ userId: viewer.userId, name: viewer.name, imageUrl: viewer.imageUrl, role: viewer.role, clerk: authMode() === 'clerk' }}
    />
  )
}
