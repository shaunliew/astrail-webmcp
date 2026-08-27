// RLS-direct Supabase reads/writes (architecture: most reads skip the backend).
// Replaces mock-api for the real app; mock-api stays for offline shell/tests only.
import { createClient } from '@/lib/supabase/client'
// Mock-auth shell: reads come from the offline Tokyo fixture with zero backend
// (mirrors the MOCK_AUTH_ENABLED switches in middleware.ts and use-user.ts).
import { MOCK_AUTH_ENABLED } from '@/lib/auth/mock-auth'
import { resolveBackendUrl } from '@/lib/backend-url'
import * as mockApi from '@/lib/trip/mock-api'
import { DEMO_MEMORY_FACTS } from '@/lib/trip/fixtures'
import type { ProfileInput } from '@/lib/onboarding/onboarding'
import type {
  GenerationEvent, HotelSuggestion, Place, RestaurantSuggestion, SettingsPreferencesResponse,
  Trip, TripBundle, TripDay, TripInspirationItem, TripPlace, TransportLeg, TravelerProfile,
  UserPreferenceFact,
} from '@/lib/trip/backend-types'

// Same shared resolver (and loud prod guard) the other backend call sites use, so an unset
// NEXT_PUBLIC_BACKEND_URL fails the prod build rather than silently pointing at localhost.
const BACKEND_URL = resolveBackendUrl()

export async function saveProfile(input: ProfileInput): Promise<TravelerProfile> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')
  // Upsert: the profile row may not exist yet (no auto-create trigger for traveler_profiles).
  const { data, error } = await supabase
    .from('traveler_profiles')
    .upsert({ id: user.id, ...input, onboarding_completed: true })
    .select('id,origin_city,travel_style_tags,preference_tags,preference_notes,onboarding_completed')
    .single()
  if (error) throw new Error(`Could not save your preferences: ${error.message}`)
  return data as TravelerProfile
}

// Read the saved profile (origin, style, interests, notes) straight from the RLS-guarded
// traveler_profiles row — the plan sheet pre-fills from it, and Settings displays it.
// `facts` here are the STRUCTURED onboarding facts, distinct from mem0's remembered prose:
// the mem0 memories live behind the backend and are read via getMemoryPreferences().
export async function getProfile(): Promise<{ profile: TravelerProfile; facts: UserPreferenceFact[] }> {
  if (MOCK_AUTH_ENABLED) return mockApi.getProfile()
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')
  const { data } = await supabase
    .from('traveler_profiles')
    .select('id,origin_city,travel_style_tags,preference_tags,preference_notes,onboarding_completed')
    .eq('id', user.id)
    .maybeSingle()
  const profile: TravelerProfile = (data as TravelerProfile | null) ?? {
    id: user.id, origin_city: null, travel_style_tags: [], preference_tags: [], preference_notes: null, onboarding_completed: false,
  }
  return { profile, facts: [] }
}

// The user's STORED mem0 memories (GET /settings/preferences). Unlike getProfile this hits
// the backend, because mem0 is server-side only. Returns prose memories (MemoryFact), NOT
// UserPreferenceFact — mem0 gives sentences, and inventing fact_key/confidence to fit the
// structured shape would fabricate data shown to the user (guardrail #1 / api/schemas.py).
// `status` lets Settings tell "nothing saved yet" (ok, []) from "memory is down"
// (unavailable, []). Any transport/parse failure degrades to `unavailable` rather than
// throwing, and never surfaces the bearer token (guardrail: log the error type only).
export async function getMemoryPreferences(): Promise<SettingsPreferencesResponse> {
  if (MOCK_AUTH_ENABLED) return { status: 'ok', facts: DEMO_MEMORY_FACTS }
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return { status: 'unavailable', facts: [] }
  try {
    const res = await fetch(`${BACKEND_URL}/settings/preferences`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    if (!res.ok) return { status: 'unavailable', facts: [] }
    return (await res.json()) as SettingsPreferencesResponse
  } catch {
    return { status: 'unavailable', facts: [] }
  }
}

export async function getTrip(tripId: string): Promise<TripBundle | null> {
  if (MOCK_AUTH_ENABLED) return mockApi.getTrip(tripId)
  const supabase = createClient()
  const { data: trip, error } = await supabase
    .from('trips').select('*').eq('id', tripId).maybeSingle()
  if (error || !trip) return null // RLS: another user's trip reads as absent

  const [inspiration, places, days, legs, restaurants, hotels, events] = await Promise.all([
    supabase.from('trip_inspiration_items').select('*').eq('trip_id', tripId),
    supabase.from('trip_places').select('*, place:places(*)').eq('trip_id', tripId)
      .order('day_number').order('sort_order'),
    supabase.from('trip_days').select('*').eq('trip_id', tripId).order('day_number'),
    supabase.from('transport_legs').select('*').eq('trip_id', tripId).order('leg_order'),
    supabase.from('restaurant_suggestions').select('*').eq('trip_id', tripId),
    // Rank order is load-bearing: the panel lists hotels top-down, so the Recommended (rank 1)
    // hub must come first. `nullsFirst: false` sinks placed-but-unranked (top-3 overflow) and
    // unresolved hotels below the ranked shortlist; `.order('id')` is a deterministic tiebreak.
    supabase.from('hotel_suggestions').select('*').eq('trip_id', tripId)
      .order('rank', { ascending: true, nullsFirst: false }).order('id'),
    supabase.from('generation_events').select('*').eq('trip_id', tripId)
      .order('created_at').order('id'),
  ])

  /* Map pins show the source Reel's cover as EVIDENCE, and that cover lives on `reel_cache`,
     not on `trip_inspiration_items` (which carries only `reel_cache_id`). A client-side
     PostgREST embed of reel_cache is not merely empty but DENIED: migration
     20260718130000 runs `revoke all on public.reel_cache from public, anon, authenticated`.
     `saved_reel_cards` is the user-scoped view that already performs the join server-side —
     the same surface the Saved Reels tray reads — so resolve covers through it. A Reel the
     user has since removed from Saved Reels simply yields no cover, and the pin falls back
     to the universal placeholder, which is the correct degradation. */
  const inspirationRows = (inspiration.data ?? []) as TripInspirationItem[]
  const reelUrls = [...new Set(
    inspirationRows.map((i) => i.normalized_reel_url).filter((u): u is string => Boolean(u)),
  )]
  const covers = new Map<string, string>()
  if (reelUrls.length > 0) {
    const { data: cards } = await supabase
      .from('saved_reel_cards').select('normalized_url, thumbnail_url').in('normalized_url', reelUrls)
    for (const card of (cards ?? []) as { normalized_url: string, thumbnail_url: string | null }[]) {
      if (card.thumbnail_url) covers.set(card.normalized_url, card.thumbnail_url)
    }
  }

  const tripPlaces = (places.data ?? []) as unknown as TripPlace[]
  const restaurantRows = (restaurants.data ?? []) as RestaurantSuggestion[]

  /* Suggestion places are NOT trip stops, so the `trip_places` join above never
     returns them and the place index built from it cannot name them. Fetch the
     ones a suggestion actually references, skipping any already on the trip. */
  const onTrip = new Set(tripPlaces.map((tp) => tp.place_id))
  const wanted = [
    ...new Set(
      restaurantRows
        .flatMap((r) => [r.restaurant_place_id, r.near_place_id])
        .filter((id): id is string => Boolean(id) && !onTrip.has(id as string)),
    ),
  ]
  const suggestionPlaces = wanted.length
    ? ((await supabase.from('places').select('*').in('id', wanted)).data ?? [])
    : []

  return {
    trip: trip as Trip,
    inspiration: inspirationRows.map((i) => ({
      ...i,
      thumbnail_url: (i.normalized_reel_url && covers.get(i.normalized_reel_url)) || null,
    })),
    places: tripPlaces,
    days: (days.data ?? []) as TripDay[],
    transport_legs: (legs.data ?? []) as TransportLeg[],
    restaurants: restaurantRows,
    hotels: (hotels.data ?? []) as HotelSuggestion[],
    events: (events.data ?? []) as GenerationEvent[],
    suggestion_places: suggestionPlaces as Place[],
  }
}

export async function listTrips(): Promise<Trip[]> {
  if (MOCK_AUTH_ENABLED) return mockApi.listTrips()
  const supabase = createClient()
  const { data, error } = await supabase
    .from('trips').select('*').order('created_at', { ascending: false })
  if (error) throw new Error(`Could not load trips: ${error.message}`)
  return (data ?? []) as Trip[]
}
