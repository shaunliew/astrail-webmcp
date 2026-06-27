import type { GenerateTripRequest, GenerateTripResponse } from './backend-types'

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
