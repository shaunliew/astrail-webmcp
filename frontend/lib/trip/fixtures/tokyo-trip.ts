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

const P = {
  senso: place('pl_senso', 'Senso-ji Temple', 'attraction', 35.7148, 139.7967, 'Asakusa'),
  shibuya: place('pl_shibuya', 'Shibuya Sky', 'attraction', 35.6580, 139.7016, 'Shibuya'),
  ichiran: place('pl_ichiran', 'Ichiran Shibuya', 'restaurant', 35.6606, 139.7002, 'Shibuya'),
  teamlab: place('pl_teamlab', 'teamLab Planets', 'attraction', 35.6497, 139.7906, 'Toyosu'),
  disney: place('pl_disney', 'Tokyo Disneyland', 'attraction', 35.6329, 139.8804, 'Urayasu'),
  hotelBase: place('pl_hotelbase', 'Shinjuku Granbell Hotel', 'hotel', 35.6938, 139.7034, 'Shinjuku'),
}

const trip: Trip = {
  id: TRIP_ID, user_id: USER_ID, status: 'saved_with_gaps',
  destination_hint: 'Tokyo, Japan', inferred_destination: 'Tokyo, Japan',
  start_date: '2026-08-14', end_date: '2026-08-16',
  origin_city: 'Kuala Lumpur', budget_level: 'mid_range',
  adult_count: 2, child_count: 0, room_count: 1,
  preference_sources: ['explicit', 'memory'],
  preference_summary: 'Walkable days, ramen, not too rushed, mid-range budget.',
  title: null, summary: null,
  tradeoffs: {
    notes: [
      {
        kind: 'long_leg', scope: 'day', severity: 'warn',
        detail: 'The Shibuya Sky to Tokyo Disneyland leg could not be routed; public transit is likely more practical for this long transfer.',
        day_number: 3, refs: ['leg_3'], leg_m: 17800,
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
  tp('tp_senso', P.senso, 'reel_extracted', {
    confidence: 0.94, source_url: 'https://www.instagram.com/reel/AAA/',
    quote: 'you HAVE to see Senso-ji at sunrise', quotes: ['you HAVE to see Senso-ji at sunrise'],
    rationale: null, evidence_kind: 'reel_quote',
  }, 1, 0),
  tp('tp_teamlab', P.teamlab, 'reel_extracted', {
    confidence: 0.9, source_url: 'https://www.instagram.com/reel/BBB/',
    quote: 'teamLab Planets is unreal 🌊', quotes: ['teamLab Planets is unreal 🌊'],
    rationale: null, evidence_kind: 'reel_quote',
  }, 1, 1),
  tp('tp_shibuya', P.shibuya, 'reel_extracted', {
    confidence: 0.88, source_url: 'https://www.instagram.com/reel/CCC/',
    quote: 'Shibuya Sky at golden hour', quotes: ['Shibuya Sky at golden hour'],
    rationale: null, evidence_kind: 'reel_quote',
  }, 2, 0),
  tp('tp_ichiran', P.ichiran, 'agent_suggested', {
    confidence: 0.8, source_url: 'https://ichiran.com/', quote: null, quotes: [],
    rationale: 'Ramen near Shibuya Sky matching your ramen + walkable preference.',
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
    id: 'day_1', trip_id: TRIP_ID, day_number: 1, day_date: '2026-08-14',
    title: 'Old Tokyo & digital art', summary: 'Asakusa temples, then teamLab Planets.',
    weather_summary: 'Warm, 31°C, afternoon showers likely.', weather_source: 'open_meteo',
    weather_payload: { temperatureC: 31, precipitationChance: 55 },
  },
  {
    id: 'day_2', trip_id: TRIP_ID, day_number: 2, day_date: '2026-08-15',
    title: 'Shibuya heights & ramen', summary: 'Shibuya Sky at golden hour, ramen after.',
    weather_summary: 'Clear, 33°C.', weather_source: 'open_meteo',
    weather_payload: { temperatureC: 33, precipitationChance: 10 },
  },
  {
    id: 'day_3', trip_id: TRIP_ID, day_number: 3, day_date: '2026-08-16',
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
  leg('leg_1', 'day_1', P.senso, P.teamlab, 0, 'ok', 'drive', 'driving', 1500, 9200, null),
  leg('leg_2', 'day_2', P.shibuya, P.ichiran, 0, 'ok', 'walk', 'walking', 240, 300, null),
  // Baked partial failure (PRD §17): no route to Disneyland.
  leg('leg_3', 'day_3', P.shibuya, P.disney, 0, 'no_route', 'transit_hint', null, null, null,
    'Long transfer. Public transit may be preferable; detailed train routing is not available in v1.'),
]

const restaurants: RestaurantSuggestion[] = [
  {
    id: 'rest_1', trip_id: TRIP_ID, trip_day_id: 'day_2',
    restaurant_place_id: 'pl_ichiran', near_place_id: 'pl_shibuya', cuisine: 'Ramen',
    summary: 'Classic tonkotsu near Shibuya Sky — matches your ramen preference.',
    source_url: 'https://ichiran.com/', evidence_json: { evidence_kind: 'suggested_by_astrail' },
    preference_match_json: { matched: ['ramen', 'walkable'] },
  },
]

const hotels: HotelSuggestion[] = [
  {
    id: 'hotel_1', trip_id: TRIP_ID, trip_day_id: null, base_place_id: 'pl_hotelbase', // single base hotel — intentionally not tied to a specific day
    name: 'Shinjuku Granbell Hotel', area: 'Shinjuku', star_rating: 4,
    price_snapshot: { currency: 'USD', nightly: 128 }, travala_hotel_id: 'tv_12345',
    preference_match_json: { matched: ['central', 'mid_range'] },
    source: 'travala', status: 'suggested', searched_at: '2026-08-01T09:02:30Z',
    // Hotel-hub: geocoded + ranked #1 (the route-central recommended hub). Coords match pl_hotelbase.
    lat: 35.6938, lng: 139.7034, geo_status: 'placed', route_score: 0.82, rank: 1, is_recommended: true,
    place_durations: { pl_senso: 4500, pl_teamlab: 6000, pl_shibuya: 2700, pl_ichiran: 2700, pl_disney: 11000 },
  },
  // Baked partial failure (PRD §17): a skipped hotel search → honest-failure: unresolved, no coords, no pin.
  {
    id: 'hotel_2', trip_id: TRIP_ID, trip_day_id: 'day_3', base_place_id: null,
    name: 'Near Tokyo Disneyland', area: 'Urayasu', star_rating: null,
    price_snapshot: {}, travala_hotel_id: null, preference_match_json: {},
    source: 'travala', status: 'skipped', searched_at: null,
    // Hotel-hub: never placed on the map (Guardrail #1) — nullable geo/rank fields stay null.
    lat: null, lng: null, geo_status: 'unresolved', route_score: null, rank: null, is_recommended: false,
    place_durations: {},
  },
]

const inspiration: TripInspirationItem[] = [
  {
    id: 'insp_1', trip_id: TRIP_ID, item_type: 'reel_url', source: 'manual_paste',
    normalized_reel_url: 'https://www.instagram.com/reel/AAA/', reel_cache_id: 'rc_1',
    requested_place_text: null, resolved_place_id: 'pl_senso', status: 'places_found',
    thumbnail_url: null,
  },
  {
    id: 'insp_2', trip_id: TRIP_ID, item_type: 'reel_url', source: 'clipboard',
    normalized_reel_url: 'https://www.instagram.com/reel/BBB/', reel_cache_id: 'rc_2',
    requested_place_text: null, resolved_place_id: 'pl_teamlab', status: 'places_found',
    thumbnail_url: null,
  },
  {
    id: 'insp_3', trip_id: TRIP_ID, item_type: 'requested_place', source: 'manual_input',
    normalized_reel_url: null, reel_cache_id: null,
    requested_place_text: 'Tokyo Disneyland', resolved_place_id: 'pl_disney', status: 'resolved',
    thumbnail_url: null,
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
  ev('ge_1', 'stage', 'scrape', 'Scraped 3 Reels.', 3),
  ev('ge_2', 'decision', 'extract', 'Found 6 candidate places.', 12),
  ev('ge_3', 'decision', 'dedup', 'Dropped 1 place without coordinates. Mapped 4 verified places.', 18),
  ev('ge_4', 'decision', 'resolve', 'Resolved Tokyo Disneyland from your request.', 20),
  ev('ge_5', 'decision', 'preferences', 'Using saved preference memory: walkable days, ramen, balanced pace.', 22),
  ev('ge_6', 'decision', 'transport', 'Computed 2 of 3 route legs.', 40),
  ev('ge_7', 'warning', 'transport', 'Could not route Shibuya Sky → Tokyo Disneyland.', 41),
  ev('ge_8', 'warning', 'hotels', 'Skipped a hotel search near Disneyland (missing dates for that leg).', 46),
  ev('ge_9', 'decision', 'save', 'Saved trip with gaps.', 55),
]

export const TOKYO_TRIP: TripBundle = {
  trip, inspiration, places, days, transport_legs, restaurants, hotels, events,
  // The mock's restaurants point at places already on the trip, so nothing extra
  // is needed to resolve their names.
  suggestion_places: [],
}
