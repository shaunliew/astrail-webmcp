import type {
  TripBundle, Place, TripPlace, TripDay, TransportLeg,
  RestaurantSuggestion, HotelSuggestion, TripInspirationItem, GenerationEvent, Trip,
} from '@/lib/trip/backend-types'

const TRIP_ID = 'trip_tokyo_demo'
const USER_ID = 'demo-user'

const place = (
  id: string, name: string, place_type: Place['place_type'],
  lat: number, lng: number, area: string,
): Place => ({
  id, name, name_local: null, place_type, lat, lng,
  country: 'Japan', city: 'Tokyo', area, aliases: [], source_summary: {},
})

/* Every reel-sourced stop below is REAL, and verifiable without leaving the repo.
   The Reel URLs are the frozen Case 1 demo set (`docs/evals/japan-beta-input-template.md`), the
   captions they quote are the Apify captures in `backend/evals/fixtures/japan_demo_reels.json`,
   and the coordinates are the ones the extractor resolved in `backend/evals/fixtures/`
   `expected_places.json`. They are also the same Reels the /app starter prompt pastes
   (`components/reels/TraysScreen.tsx`), so the sample trail and the prompt tell one story.

   This replaced three invented codes — /reel/AAA, /BBB, /CCC — that 404 on Instagram. On the one
   page whose whole job is proving "every recommendation surfaces its source Reel", a judge
   clicking `source` landed on an error. The Doraemon Reel of that set is deliberately left out
   for the reason TraysScreen gives: its own caption closes the exhibition on 30 September 2026. */
const REEL_HARRY_POTTER = 'https://www.instagram.com/reel/DYGH3jFBZHz/'
const REEL_SANDO = 'https://www.instagram.com/reel/DXwcVVliX3B/'

const P = {
  akasaka: place('pl_akasaka', 'Akasaka Station', 'station', 35.6723639, 139.7365333, 'Akasaka'),
  hpcafe: place('pl_hpcafe', 'Harry Potter Cafe', 'restaurant', 35.6730773, 139.7363882, 'Akasaka'),
  sandolab: place('pl_sandolab', 'SANDO LAB TOKYO', 'restaurant', 35.7007615, 139.7717192, 'Akihabara'),
  ichiran: place('pl_ichiran', 'Ichiran Shibuya', 'restaurant', 35.6606, 139.7002, 'Shibuya'),
  disney: place('pl_disney', 'Tokyo Disneyland', 'attraction', 35.6329, 139.8804, 'Urayasu'),
  hotelBase: place('pl_hotelbase', 'Shinjuku Granbell Hotel', 'hotel', 35.6938, 139.7034, 'Shinjuku'),
}

const trip: Trip = {
  id: TRIP_ID, user_id: USER_ID, status: 'saved_with_gaps',
  destination_hint: 'Tokyo, Japan', inferred_destination: 'Tokyo, Japan',
  // A near-future window, deliberately. These were 2026-08-14..16 — already in the past, so the
  // flagship demo read as a trip that had been and gone. Fri-Sun, and the day weather below is
  // written for a Tokyo mid-September (still warm, still showery), so the two stay consistent.
  start_date: '2026-09-18', end_date: '2026-09-20',
  origin_city: 'Kuala Lumpur', budget_level: 'mid_range',
  adult_count: 2, child_count: 0, room_count: 1,
  preference_sources: ['explicit', 'memory'],
  preference_summary: 'Walkable days, ramen, not too rushed, mid-range budget.',
  title: null, summary: null,
  tradeoffs: {
    notes: [
      {
        kind: 'long_leg', scope: 'day', severity: 'warn',
        detail: 'The Ichiran Shibuya to Tokyo Disneyland leg could not be routed; public transit is likely more practical for this long transfer.',
        day_number: 3, refs: ['leg_3'], leg_m: 19000,
      },
    ],
    comparisons: [
      {
        axis: 'price_vs_rating', scope: 'hotel',
        option_a: {
          label: 'Shinjuku Granbell Hotel', value: 'USD 128/night · 4★',
          pro: 'Central base with a confirmed mid-range price and a 4-star rating.',
          con: 'Adds transfer time on the Disneyland day.',
        },
        option_b: {
          label: 'Near Tokyo Disneyland', value: 'Price unavailable',
          pro: 'Would keep the longest day closer to the park.',
          con: 'The hotel search was skipped, so price and rating are not confirmed.',
        },
        recommendation: 'Keep the Shinjuku base unless Disneyland convenience matters more than a confirmed price and rating.',
        refs: ['hotel_1', 'hotel_2'],
      },
    ],
  },
  created_at: '2026-08-01T09:00:00Z', updated_at: '2026-08-01T09:03:00Z',
}

const tp = (
  id: string, p: Place, source_type: TripPlace['source_type'],
  ev: TripPlace['evidence_json'], day_number: number | null, sort_order: number | null,
): TripPlace => ({
  id, trip_id: TRIP_ID, place_id: p.id, source_type,
  evidence_json: ev, day_number, sort_order, place: p,
})

const places: TripPlace[] = [
  /* Quotes are VERBATIM substrings of the captured caption for the Reel each one cites — the
     check `lib/trip/fixtures/__tests__/tokyo-trip.test.ts` runs against
     `backend/evals/fixtures/japan_demo_reels.json`. The Reel goes in `source_reel_url`, never in
     `source_url`: backend-types.ts reserves `source_url` for an independent research/venue page
     and `backend/pipeline/persist.py::_evidence_json` writes exactly that split. We hold no
     verified research page for these three, so `source_url` stays null — an absent link is
     honest, a broken one is not. Confidences are the extractor's own, from expected_places.json. */
  tp('tp_akasaka', P.akasaka, 'reel_extracted', {
    confidence: 0.65, source_url: null, source_reel_url: REEL_HARRY_POTTER,
    quote: 'HARRY POTTER TRAIN STATION IN TOKYO!',
    quotes: ['HARRY POTTER TRAIN STATION IN TOKYO!'],
    rationale: null, evidence_kind: 'reel_quote',
  }, 1, 0),
  tp('tp_hpcafe', P.hpcafe, 'reel_extracted', {
    confidence: 0.65, source_url: null, source_reel_url: REEL_HARRY_POTTER,
    quote: 'reservations are required if you plan to dine at the Harry Potter Cafe',
    quotes: ['reservations are required if you plan to dine at the Harry Potter Cafe'],
    rationale: null, evidence_kind: 'reel_quote',
  }, 1, 1),
  tp('tp_sandolab', P.sandolab, 'reel_extracted', {
    confidence: 0.65, source_url: null, source_reel_url: REEL_SANDO,
    quote: 'Spots like Sando Lab Tokyo are known for their modern, picture-perfect creations',
    quotes: ['Spots like Sando Lab Tokyo are known for their modern, picture-perfect creations'],
    rationale: null, evidence_kind: 'reel_quote',
  }, 2, 0),
  tp('tp_ichiran', P.ichiran, 'agent_suggested', {
    confidence: 0.8, source_url: 'https://ichiran.com/', quote: null, quotes: [],
    rationale: 'Ramen to close the sando day, matching your ramen preference.',
    evidence_kind: 'suggested_by_astrail',
  }, 2, 1),
  tp('tp_disney', P.disney, 'user_requested', {
    confidence: 1, source_url: null, quote: 'Also want to go Tokyo Disneyland',
    quotes: ['Also want to go Tokyo Disneyland'],
    rationale: null, evidence_kind: 'requested_by_you',
  }, 3, 0),
  tp('tp_hotelbase', P.hotelBase, 'agent_suggested', {
    confidence: 0.75, source_url: null, quote: null, quotes: [],
    rationale: 'Central Shinjuku base suggested for the trip; not tied to a specific day.',
    evidence_kind: 'suggested_by_astrail',
  }, null, null),
]

const days: TripDay[] = [
  {
    id: 'day_1', trip_id: TRIP_ID, day_number: 1, day_date: '2026-09-18',
    title: 'Akasaka & the wizarding platform', summary: 'The Harry Potter station, then the cafe above it.',
    weather_summary: 'Warm, 31°C, afternoon showers likely.', weather_source: 'open_meteo',
    weather_payload: { temperatureC: 31, precipitationChance: 55 },
  },
  {
    id: 'day_2', trip_id: TRIP_ID, day_number: 2, day_date: '2026-09-19',
    title: 'Sando crawl, then ramen', summary: 'The viral sando counter in Akihabara, ramen in Shibuya after.',
    weather_summary: 'Clear, 33°C.', weather_source: 'open_meteo',
    weather_payload: { temperatureC: 33, precipitationChance: 10 },
  },
  {
    id: 'day_3', trip_id: TRIP_ID, day_number: 3, day_date: '2026-09-20',
    title: 'Tokyo Disneyland', summary: 'Full-day anchor at your requested park.',
    weather_summary: null, weather_source: 'none', weather_payload: {}, // intentional weather gap — beyond forecast window
  },
]

// Road-shaped mock geometry: a deterministic dogleg between stops so the offline demo
// draws a plausible route instead of a straight pin-to-pin line. Real road polylines
// come from Mapbox Directions once the backend requests them (issue #42) — endpoints
// stay exact so the trail always meets the pins.
const roadish = (from: Place, to: Place): NonNullable<TransportLeg['route_geometry']> => {
  const dx = to.lng - from.lng
  const dy = to.lat - from.lat
  const bends = [0, 0.35, -0.25, 0.3, -0.15, 0] // fixed wiggle profile, first/last = exact endpoints
  const last = bends.length - 1
  return {
    type: 'LineString',
    coordinates: bends.map((b, i) => [
      from.lng + dx * (i / last) + -dy * b * 0.12,
      from.lat + dy * (i / last) + dx * b * 0.12,
    ]),
  }
}

const leg = (
  id: string, day: string, from: Place, to: Place, order: number,
  status: TransportLeg['status'], mode: TransportLeg['transport_mode'],
  profile: TransportLeg['routing_profile'], dur: number | null, dist: number | null,
  warning: string | null,
): TransportLeg => ({
  id, trip_id: TRIP_ID, trip_day_id: day, from_place_id: from.id, to_place_id: to.id,
  leg_order: order, transport_mode: mode, routing_provider: profile ? 'mapbox' : 'none',
  routing_profile: profile, status, duration_seconds: dur, distance_meters: dist,
  route_geometry: status === 'ok' ? roadish(from, to) : null,
  warning,
})

const transport_legs: TransportLeg[] = [
  // Distances are the real ones between the coordinates above: the cafe is in the tower over the
  // station (80 m as the crow flies), Akihabara to Shibuya is a genuine cross-city hop.
  leg('leg_1', 'day_1', P.akasaka, P.hpcafe, 0, 'ok', 'walk', 'walking', 150, 130, null),
  leg('leg_2', 'day_2', P.sandolab, P.ichiran, 0, 'ok', 'drive', 'driving', 1620, 9500, null),
  // Baked partial failure (PRD §17): no route to Disneyland.
  leg('leg_3', 'day_3', P.ichiran, P.disney, 0, 'no_route', 'transit_hint', null, null, null,
    'Long transfer. Public transit may be preferable; detailed train routing is not available in v1.'),
]

/* The eat-marker place. It was 'Koma Sushi' in Asakusa — a name and a coordinate with nothing
   behind either, on a page that exists to prove nothing is invented. Popo is one of the four
   sando shops the same Reel names, at the coordinate the extractor resolved for it
   (expected_places.json), 3.5 km from the SANDO LAB stop it is anchored to. Astrail surfacing a
   real nearby shop is a suggestion; the popup shows no Reel for it, which stays true. */
const suggestionOnlyRestaurant = place(
  'pl_popo', 'Popo', 'restaurant', 35.73159532, 139.76540491, 'Nishi-Nippori',
)

const restaurants: RestaurantSuggestion[] = [
  {
    id: 'rest_2', trip_id: TRIP_ID, trip_day_id: 'day_2',
    restaurant_place_id: 'pl_popo', near_place_id: 'pl_sandolab', cuisine: 'sandwiches',
    summary: 'Fruit sandos a short ride north of the sando counter, if one shop is not enough.',
    source_url: null, evidence_json: { evidence_kind: 'suggested_by_astrail' },
    preference_match_json: { matched: ['walkable'] },
  },
  {
    id: 'rest_1', trip_id: TRIP_ID, trip_day_id: 'day_2',
    restaurant_place_id: 'pl_ichiran', near_place_id: 'pl_sandolab', cuisine: 'Ramen',
    summary: 'Classic tonkotsu to close the sando day — matches your ramen preference.',
    source_url: 'https://ichiran.com/', evidence_json: { evidence_kind: 'suggested_by_astrail' },
    preference_match_json: { matched: ['ramen', 'walkable'] },
  },
]

const hotels: HotelSuggestion[] = [
  {
    id: 'hotel_1', trip_id: TRIP_ID, trip_day_id: null, base_place_id: 'pl_hotelbase', // single base hotel — intentionally not tied to a specific day
    name: 'Shinjuku Granbell Hotel', area: 'Shinjuku', star_rating: 4,
    // Snapshot keys mirror persist_hotels' real write shape (pricePerNight/totalPrice/currency) —
    // the earlier `nightly` key was fixture drift the backend never wrote.
    price_snapshot: { currency: 'USD', pricePerNight: 128, totalPrice: 384 }, travala_hotel_id: 'tv_12345',
    preference_match_json: { matched: ['central', 'mid_range'] },
    source: 'travala', status: 'suggested', searched_at: '2026-08-01T09:02:30Z',
    // Hotel-hub: geocoded + ranked #1 (the route-central recommended hub). Coords match pl_hotelbase.
    // route_score is the mean route duration to the trip's places in SECONDS (not a 0-1 score).
    lat: 35.6938, lng: 139.7034, geo_status: 'placed', route_score: 420, rank: 1, is_recommended: true,
    // Projected by getTrip from travala_result_json (guest score is 0-10, NOT the 1-5 star class).
    // The deadline is a snapshot taken at searched_at, so it can be in the past by the time a
    // trip is reopened — this one deliberately is, to exercise that.
    guest_rating: 9.4, refundable: true, free_cancellation_until: '2026-08-10T14:59:00Z',
    place_durations: { pl_akasaka: 1500, pl_hpcafe: 1500, pl_sandolab: 2400, pl_ichiran: 1500, pl_disney: 11000 },
  },
  // Baked partial failure (PRD §17): a skipped hotel search → honest-failure: unresolved, no coords, no pin.
  {
    id: 'hotel_2', trip_id: TRIP_ID, trip_day_id: 'day_3', base_place_id: null,
    name: 'Near Tokyo Disneyland', area: 'Urayasu', star_rating: null,
    price_snapshot: {}, travala_hotel_id: null, preference_match_json: {},
    source: 'travala', status: 'skipped', searched_at: null,
    // Hotel-hub: never placed on the map (Guardrail #1) — nullable geo/rank fields stay null.
    lat: null, lng: null, geo_status: 'unresolved', route_score: null, rank: null, is_recommended: false,
    guest_rating: null, refundable: null, free_cancellation_until: null,
    place_durations: {},
  },
]

const inspiration: TripInspirationItem[] = [
  {
    id: 'insp_1', trip_id: TRIP_ID, item_type: 'reel_url', source: 'manual_paste',
    normalized_reel_url: REEL_HARRY_POTTER, reel_cache_id: 'rc_1',
    requested_place_text: null, resolved_place_id: 'pl_akasaka', status: 'places_found',
    thumbnail_url: '/landing/globe-japan.webp',
  },
  {
    id: 'insp_2', trip_id: TRIP_ID, item_type: 'reel_url', source: 'clipboard',
    normalized_reel_url: REEL_SANDO, reel_cache_id: 'rc_2',
    requested_place_text: null, resolved_place_id: 'pl_sandolab', status: 'places_found',
    thumbnail_url: '/landing/coldopen-hero.webp',
  },
  {
    id: 'insp_3', trip_id: TRIP_ID, item_type: 'requested_place', source: 'manual_input',
    normalized_reel_url: null, reel_cache_id: null,
    requested_place_text: 'Tokyo Disneyland', resolved_place_id: 'pl_disney', status: 'resolved',
    thumbnail_url: '/landing/cta.webp',
  },
]

const ev = (
  id: string, event_type: GenerationEvent['event_type'], stage: GenerationEvent['stage'],
  message: string, offsetS: number,
): GenerationEvent => ({
  id, trip_id: TRIP_ID, event_type, stage, message, payload: {},
  created_at: new Date(Date.parse('2026-08-01T09:00:00Z') + offsetS * 1000).toISOString(),
})

const events: GenerationEvent[] = [
  ev('ge_1', 'stage', 'scrape', 'Scraped 2 Reels.', 3),
  ev('ge_2', 'decision', 'extract', 'Found 5 candidate places.', 12),
  ev('ge_3', 'decision', 'dedup', 'Dropped 1 place without coordinates. Mapped 3 verified places.', 18),
  ev('ge_4', 'decision', 'resolve', 'Resolved Tokyo Disneyland from your request.', 20),
  ev('ge_5', 'decision', 'preferences', 'Using saved preference memory: walkable days, ramen, balanced pace.', 22),
  ev('ge_6', 'decision', 'transport', 'Computed 2 of 3 route legs.', 40),
  ev('ge_7', 'warning', 'transport', 'Could not route Ichiran Shibuya → Tokyo Disneyland.', 41),
  ev('ge_8', 'warning', 'hotels', 'Skipped a hotel search near Disneyland (missing dates for that leg).', 46),
  ev('ge_9', 'decision', 'save', 'Saved trip with gaps.', 55),
]

export const TOKYO_TRIP: TripBundle = {
  trip, inspiration, places, days, transport_legs, restaurants, hotels, events,
  /* `rest_1` points at a place already ON the trip, so it resolves through the trip's own
     places and produces NO eat marker — correct (that stop already has a trail pin), but it
     meant the fixture could not exercise the "Where to eat" markers at all, and a real trip is
     the opposite shape: its restaurant suggestions are overwhelmingly places that are NOT
     stops. `rest_2` is that case, so the eat-pin path is now covered. */
  suggestion_places: [suggestionOnlyRestaurant],
}
