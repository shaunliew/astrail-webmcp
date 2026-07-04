import type {
  TripBundle, Trip, TravelerProfile, UserPreferenceFact, StreamEvent,
  GenerateTripRequest, GenerateTripResponse,
} from '@/lib/trip/backend-types'
import { TOKYO_TRIP, DEMO_PROFILE, DEMO_PREFERENCE_FACTS } from '@/lib/trip/fixtures'

// Simulated network latency so loading/skeleton states are visible in the shell.
export const MOCK_LATENCY_MS = 350

// Note: delay() uses setTimeout — tests that await the async API fns under fake timers must advance the timers.
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function getTrip(tripId: string): Promise<TripBundle | null> {
  await delay(MOCK_LATENCY_MS)
  return tripId === TOKYO_TRIP.trip.id ? TOKYO_TRIP : null
}

export async function listTrips(): Promise<Trip[]> {
  await delay(MOCK_LATENCY_MS)
  return [TOKYO_TRIP.trip]
}

export async function getProfile(): Promise<{
  profile: TravelerProfile
  facts: UserPreferenceFact[]
}> {
  await delay(MOCK_LATENCY_MS)
  return { profile: DEMO_PROFILE, facts: DEMO_PREFERENCE_FACTS }
}

export type FeedbackInput = {
  trip_id: string
  artifact_type: string
  artifact_id: string | null
  rating?: number
  comment?: string
}

export async function submitFeedback(_input: FeedbackInput): Promise<{ ok: true }> {
  await delay(MOCK_LATENCY_MS)
  return { ok: true }
}

// Simulates POST /trips: creates the durable trip row and returns its id (PRD §16: trip row < 2s).
// Offline/deterministic — always resolves to the Tokyo fixture so streamGeneration can chain onto it.
export async function createTrip(req: GenerateTripRequest): Promise<GenerateTripResponse> {
  await delay(MOCK_LATENCY_MS)
  if (req.reel_urls.length + req.requested_places.length < 1) {
    throw new Error('Provide at least one Reel URL or requested place to generate a trip.')
  }
  return { trip_id: TOKYO_TRIP.trip.id }
}

// Scripted generation replay. Mirrors the SSE contract stage names (CLAUDE.md).
// Reveals map pins first, then days — demonstrating "time to first mapped value" (PRD §16).
const SCRIPT: Array<{ at: number; event: StreamEvent }> = [
  { at: 400, event: { type: 'stage', stage: 'scrape', msg: 'Scraping 3 Reels…' } },
  { at: 1200, event: { type: 'heartbeat', elapsed_s: 1.2 } },
  { at: 1600, event: { type: 'stage', stage: 'extract', msg: 'Extracting places…' } },
  { at: 2400, event: { type: 'stage', stage: 'dedup', msg: 'Mapped 4 verified places.' } },
  { at: 3000, event: { type: 'heartbeat', elapsed_s: 3.0 } },
  { at: 3400, event: { type: 'stage', stage: 'enrich', msg: 'Enriching places…' } },
  { at: 3800, event: { type: 'stage', stage: 'weather', msg: 'Fetching weather…' } },
  { at: 4200, event: { type: 'stage', stage: 'restaurants', msg: 'Finding route-aware restaurants…' } },
  { at: 4600, event: { type: 'stage', stage: 'transport', msg: 'Computed 2 of 3 route legs.' } },
  { at: 5200, event: { type: 'stage', stage: 'narrate', msg: 'Writing your day-by-day…' } },
  { at: 5800, event: { type: 'stage', stage: 'summarize', msg: 'Summarizing…' } },
  { at: 6200, event: { type: 'result', content: JSON.stringify({ trip_id: TOKYO_TRIP.trip.id }) } },
]

export function streamGeneration(
  _tripId: string,
  onEvent: (e: StreamEvent) => void,
): { cancel: () => void } {
  const timers: ReturnType<typeof setTimeout>[] = []
  for (const { at, event } of SCRIPT) {
    timers.push(setTimeout(() => onEvent(event), at))
  }
  return { cancel: () => timers.forEach(clearTimeout) }
}
