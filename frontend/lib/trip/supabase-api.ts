// RLS-direct Supabase reads/writes (architecture: most reads skip the backend).
// Replaces mock-api for the real app; mock-api stays for offline shell/tests only.
import { createClient } from '@/lib/supabase/client'
// Mock-auth shell: reads come from the offline Tokyo fixture with zero backend
// (mirrors the MOCK_AUTH_ENABLED switches in middleware.ts and use-user.ts).
import { MOCK_AUTH_ENABLED } from '@/lib/auth/mock-auth'
import * as mockApi from '@/lib/trip/mock-api'
import type { ProfileInput } from '@/lib/onboarding/onboarding'
import type {
  GenerationEvent, HotelSuggestion, Place, RestaurantSuggestion, Trip, TripBundle,
  TripDay, TripInspirationItem, TripPlace, TransportLeg, TravelerProfile,
} from '@/lib/trip/backend-types'

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
    supabase.from('hotel_suggestions').select('*').eq('trip_id', tripId),
    supabase.from('generation_events').select('*').eq('trip_id', tripId)
      .order('created_at').order('id'),
  ])

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
    inspiration: (inspiration.data ?? []) as TripInspirationItem[],
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
