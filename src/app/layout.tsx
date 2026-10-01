import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'OpenDots',
  description:
    'OpenDots — your always-on team of AI coworkers, powered by Claude on your subscription',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
