import { screenFrame } from '../domain/screen'
import { loadTurnContext, runBotTurn, TurnError, type TurnContext, type TurnTrigger } from './agents/run-bot-turn'

/** One SSE frame: a complete JSON object on a `data:` line. */
function frame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

/**
 * Streams a bot's reply for the latest user message in a conversation. Shared
 * by the channel route and the deployment route, which differ in how the caller
 * is authorised and therefore in how far the turn is trusted: the deployment
 * route passes `deployment_visitor`, which withholds the host-reaching tools.
 */
export async function buildRespondStream(
  channelUrl: string,
  trigger: TurnTrigger = 'user_message',
): Promise<Response> {
  let ctx: TurnContext
  try {
    ctx = await loadTurnContext(channelUrl, trigger)
  } catch (cause) {
    if (cause instanceof TurnError) {
      return Response.json({ error: cause.message, code: cause.code }, { status: cause.status })
    }
    throw cause
  }

  const encoder = new TextEncoder()
  /*
   * Tied to the response body: when the client disconnects the platform calls
   * `cancel()`, which aborts the turn. Without it the SDK subprocess keeps
   * running — and keeps spending API usage — on a reply nobody reads.
   */
  const abort = new AbortController()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, payload: unknown) => {
        // Enqueueing after cancel() throws; the turn is already unwinding.
        if (abort.signal.aborted) return
        controller.enqueue(encoder.encode(frame(event, payload)))
      }
      send('status', { state: 'responding' })
      try {
        for await (const event of runBotTurn(ctx, { signal: abort.signal })) {
          if (abort.signal.aborted) break
          switch (event.type) {
            case 'provenance':
              send('provenance', event.provenance)
              break
            case 'trace':
              send('trace', event.trace)
              break
            case 'screen': {
              const frame = screenFrame(event.screen)
              /*
               * A visitor is served frames through the deployment-scoped image
               * route, never the channel-scoped one the frame carries — sending
               * the real `imageUrl` would hand them the channel url in the
               * path. The deployed page fetches `/api/deployments/:id/screens`
               * after the turn for the thumbnails it is allowed to see.
               */
              send('screen', trigger === 'deployment_visitor' ? { ...frame, imageUrl: null } : frame)
              break
            }
            default: {
              const { type, ...payload } = event
              send(type, payload)
            }
          }
        }
      } catch (cause) {
        send('error', { error: cause instanceof Error ? cause.message : 'Bot failed to reply', kind: 'other', message: null })
      } finally {
        if (!abort.signal.aborted) controller.close()
      }
    },
    cancel() {
      abort.abort()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  })
}
