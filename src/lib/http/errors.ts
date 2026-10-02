import { NextResponse } from 'next/server'
import { Unauthenticated } from '../auth/server'
import { RepositoryError } from '../repository/chat-repository'

/** A known failure as its JSON response; null for anything else, which the route rethrows. */
export function errorResponse(error: unknown): NextResponse | null {
  if (error instanceof Unauthenticated || error instanceof RepositoryError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
  }
  return null
}

/** Runs a handler, answering not-signed-in, not-found and not-allowed as JSON instead of a 500. */
export async function withErrors(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler()
  } catch (error) {
    const response = errorResponse(error)
    if (response) return response
    throw error
  }
}
