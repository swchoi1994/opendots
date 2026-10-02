import type { Metadata } from 'next'
import { ClerkProvider } from '@clerk/nextjs'
import { authMode } from '@/lib/auth/viewer'
import './globals.css'

export const metadata: Metadata = {
  title: 'OpenDots',
  description:
    'OpenDots — your always-on team of AI coworkers, on Claude or on local models through Ollama',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/* Clerk only when it is configured: its provider needs the keys, and local mode never loads it. */}
      <body>
        {authMode() === 'clerk' ? (
          <ClerkProvider signInUrl="/sign-in" signUpUrl="/sign-up">
            {children}
          </ClerkProvider>
        ) : (
          children
        )}
      </body>
    </html>
  )
}
