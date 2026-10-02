import { SignIn } from '@clerk/nextjs'
import { redirect } from 'next/navigation'
import { connection } from 'next/server'
import { authMode } from '@/lib/auth/viewer'

/** Clerk's sign-in, with Google, Microsoft and email. Local mode has nobody to sign in, so it goes home. */
export default async function SignInPage() {
  await connection()
  if (authMode() === 'local') redirect('/')
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface p-6">
      <SignIn />
    </main>
  )
}
