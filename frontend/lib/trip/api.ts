import type { GenerateTripRequest, GenerateTripResponse, StreamEvent } from './backend-types'

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:8000'

export async function generateTrip(
  req: GenerateTripRequest,
  accessToken: string
): Promise<GenerateTripResponse> {
  const res = await fetch(`${BACKEND_URL}/generate-trip`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(req),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`generate-trip failed: ${res.status} ${text}`)
  }

  return res.json()
}

export function streamTrip(tripId: string, accessToken: string): EventSource {
  const url = new URL(`${BACKEND_URL}/generate-trip/stream/${tripId}`)
  url.searchParams.set('token', accessToken)
  return new EventSource(url.toString())
}

// EventSource wrapper matching the mock streamGeneration's { cancel } handle.
// The backend replays ALL events on each (re)connection (per-connection seen-set),
// so onReset fires on every open — callers clear their event list there to
// avoid duplicates after an auto-reconnect.
// onFail is the dead-backend escape hatch: EventSource auto-reconnects forever,
// so after 5 consecutive failed (re)connections we close and hand control back
// to the caller — otherwise a downed backend means an eternal "generating" screen.
export function streamGeneration(
  tripId: string,
  accessToken: string,
  onEvent: (e: StreamEvent) => void,
  onReset?: () => void,
  onFail?: () => void,
): { cancel: () => void } {
  const es = streamTrip(tripId, accessToken)
  let consecutiveErrors = 0
  es.onopen = () => {
    consecutiveErrors = 0
    onReset?.()
  }
  es.onerror = () => {
    consecutiveErrors += 1
    if (consecutiveErrors >= 5) {
      es.close()
      onFail?.()
    }
  }
  es.onmessage = (msg) => {
    if (msg.data === '[DONE]') {
      es.close()
      return
    }
    try {
      onEvent(JSON.parse(msg.data) as StreamEvent)
    } catch {
      // malformed line — skip (contract: heartbeat comments never reach onmessage)
    }
  }
  return { cancel: () => es.close() }
}
