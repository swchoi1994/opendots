/**
 * The server's error text for a failed API call, or `fallback`. A 401 means the
 * Clerk session ended (or never began), so the page goes to sign in again
 * rather than showing a dead screen.
 */
export async function readError(response: Response, fallback: string): Promise<string> {
  if (response.status === 401 && typeof window !== 'undefined') window.location.assign('/sign-in')
  try {
    const body = (await response.json()) as { error?: string }
    return body.error ?? fallback
  } catch {
    return fallback
  }
}
