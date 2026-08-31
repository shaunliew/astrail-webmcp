/**
 * The hotel half of the Tokyo fixture — TEST DATA, and never on a page a visitor can open.
 *
 * WHY IT LIVES HERE AND NOT IN `TOKYO_TRIP`. These rows used to sit in the demo bundle, so
 * `/app/trip/demo` — the public sample trail, the surface a WebMCP judge is most likely to open —
 * showed "Shinjuku Granbell Hotel · USD 128/night · 4★" under a Travala attribution, backed by
 * `travala_hotel_id: 'tv_12345'`. No search produced any of it. Hotel search ships OFF
 * (`backend/pipeline/runner.py::HOTEL_SEARCH_ENABLED`, 2026-08-30: Travala's MCP endpoint 401s
 * every unauthenticated call), and the disabled arm CLEARS whatever an earlier run persisted
 * (`persist.py::clear_hotels`), so a trip generated today has no hotel rows at all. An invented
 * booking id and an invented nightly price, presented as a real suggestion on a public page, is
 * exactly the fabrication this product's whole argument is against.
 *
 * It also made the demo behave unlike the product. `set_map_mode hub` SUCCEEDED here (the fixture
 * hotel is geocoded and ranked) and DECLINES on every trip made since, so a judge who tried the
 * hotel view on the sample and then on their own trip got two different answers and no
 * explanation. `TOKYO_TRIP` now carries no hotels, which is what a real trip carries, and the
 * decline is the same on both.
 *
 * WHY THE ROWS SURVIVE AT ALL. `hotel_2` is a deliberate baked partial failure (PRD §17): a
 * skipped search that never geocoded, so it has no coords and no pin — the honest-failure case
 * `HotelPanel` and the hub layer are built to handle. Deleting these rows would have deleted the
 * only coverage of the placed/unresolved pair, the rank-1 recommendation, the price-snapshot
 * reads and the hub-spoke geometry, in the name of honesty. They are the same rows, moved to
 * where they are honest: composed into `TOKYO_TRIP_WITH_HOTELS` by the suites that need a trip
 * WITH hotels, and rendered to nobody.
 *
 * The prices below are therefore synthetic on purpose and must stay out of any exported bundle a
 * route renders. `lib/trip/fixtures/__tests__/tokyo-trip.test.ts` asserts that boundary.
 */
import type {
  HotelSuggestion, Place, TripBundle, TripPlace, TripTradeoffComparison,
} from '@/lib/trip/backend-types'
import { TOKYO_TRIP } from './tokyo-trip'

const TRIP_ID = 'trip_tokyo_demo'

/** The base-hotel PLACE. Hub mode suppresses this pin as a duplicate of the hub itself, and route
 *  mode recedes it as an undayed non-stop — both behaviours need the stop to exist. It leaves
 *  `TOKYO_TRIP` with the hotels: with the search off nothing suggests a hotel, so a hotel-typed
 *  stop labelled "suggested by Astrail" sitting on the demo map beside a panel reporting no
 *  hotels was the same inconsistency wearing a different hat. */
export const HOTEL_BASE_PLACE: Place = {
  id: 'pl_hotelbase', name: 'Shinjuku Granbell Hotel', name_local: null, place_type: 'hotel',
  lat: 35.6938, lng: 139.7034, country: 'Japan', city: 'Tokyo', area: 'Shinjuku',
  aliases: [], source_summary: {},
}

export const HOTEL_BASE_STOP: TripPlace = {
  id: 'tp_hotelbase', trip_id: TRIP_ID, place_id: 'pl_hotelbase', source_type: 'agent_suggested',
  evidence_json: {
    confidence: 0.75, source_url: null, quote: null, quotes: [],
    rationale: 'Central Shinjuku base suggested for the trip; not tied to a specific day.',
    evidence_kind: 'suggested_by_astrail',
  },
  day_number: null, sort_order: null, place: HOTEL_BASE_PLACE,
}

export const DEMO_HOTELS: HotelSuggestion[] = [
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

/** The price-vs-rating card. It travels with the hotels because it is DERIVED from them: the
 *  runner only builds comparisons when the search actually ran (`if HOTEL_SEARCH_ENABLED`), since
 *  a comparison is advice — "pay more for the better-rated one" — and stating it about a search
 *  that never happened is a conclusion about nothing. On a trip with no hotels it is `[]`. */
export const HOTEL_COMPARISON: TripTradeoffComparison = {
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
}

/**
 * The Tokyo trip as it looked BEFORE hotel search was switched off — a trip that really did find
 * hotels, which is still the shape of every trip generated before 2026-08-30 and still in the
 * database. Import this wherever a suite needs hotels; import `TOKYO_TRIP` for what a trip made
 * today looks like. The pair is what lets both halves of that behaviour be tested at once.
 */
export const TOKYO_TRIP_WITH_HOTELS: TripBundle = {
  ...TOKYO_TRIP,
  trip: {
    ...TOKYO_TRIP.trip,
    tradeoffs: { ...TOKYO_TRIP.trip.tradeoffs, comparisons: [HOTEL_COMPARISON] },
  },
  places: [...TOKYO_TRIP.places, HOTEL_BASE_STOP],
  hotels: DEMO_HOTELS,
}
