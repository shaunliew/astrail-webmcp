// TypeScript mirror of the Supabase schema (snake_case, matches supabase/migrations/*.sql).
// Frontend reads most data directly from Supabase, so shapes mirror table rows verbatim.
// Draft frozen contract — reconcile with backend/models before real integration.

// ---- Enums / unions (copied from migration CHECK constraints) ----
export type TripStatus =
  | 'draft' | 'generating' | 'places_ready' | 'complete' | 'saved_with_gaps' | 'failed'
export type BudgetLevel = 'budget' | 'mid_range' | 'premium' | 'luxury'
export type PlaceSourceType = 'reel_extracted' | 'user_requested' | 'agent_suggested'
export type PlaceType =
  | 'attraction' | 'restaurant' | 'hotel' | 'area' | 'city' | 'country' | 'station' | 'shop' | 'other'
export type TransportStatus = 'pending' | 'ok' | 'no_route' | 'failed' | 'skipped'
export type RoutingProfile = 'walking' | 'driving' | 'driving-traffic' | 'cycling'
export type TransportMode = 'walk' | 'drive' | 'cycle' | 'transit_hint' | 'unknown'
export type PreferenceSource = 'explicit' | 'memory' | 'inferred_default'
export type InspirationItemType = 'reel_url' | 'requested_place'
export type InspirationSource = 'manual_paste' | 'clipboard' | 'web_share_target' | 'manual_input'
export type InspirationStatus =
  | 'valid' | 'invalid' | 'duplicate' | 'queued' | 'cached' | 'processing'
  | 'places_found' | 'needs_review' | 'failed'
  | 'pending_resolution' | 'resolved' | 'ambiguous' | 'unresolved'
export type HotelStatus = 'suggested' | 'unavailable' | 'skipped' | 'failed'
export type GenerationStage =
  | 'create_trip' | 'scrape' | 'cache_hit' | 'extract' | 'resolve' | 'preferences'
  | 'dedup' | 'enrich' | 'weather' | 'restaurants' | 'hotels' | 'transport'
  | 'narrate' | 'summarize' | 'save'
export type GenerationEventType = 'stage' | 'decision' | 'warning' | 'error' | 'heartbeat' | 'result'

// Evidence chips (PRD §15). The chip a card renders is derived from these kinds.
export type EvidenceKind =
  | 'reel_quote' | 'requested_by_you' | 'research' | 'mapbox_route'
  | 'open_meteo' | 'travala_hotel_search' | 'memory_preference'
  | 'inferred_default' | 'suggested_by_astrail'

// ---- Row shapes ----
export type Place = {
  id: string
  name: string
  name_local: string | null       // local-script name (e.g. 東京タワー), from a caption or Mapbox POI; never inferred
  place_type: PlaceType
  lat: number
  lng: number
  country: string | null
  city: string | null
  area: string | null
  aliases: string[]
  source_summary: Record<string, unknown>
}

export type TripPlaceEvidence = {
  confidence: number
  source_url: string | null
  quote: string | null            // primary verbatim reel/user quote (PRD §11/§12)
  quotes: string[]                // all merged-source quotes (dedup flywheel)
  rationale: string | null        // agent_suggested rationale
  evidence_kind: EvidenceKind
}

// Trip-level tradeoffs (PRD §667/§894). Deterministic: notes from feasibility, comparisons from hotels.
export type TripTradeoffNote = {
  kind: 'long_leg' | 'overpacked_day' | 'empty_day' | 'note'
  scope: 'trip' | 'day' | 'place'
  severity: 'info' | 'warn' | 'flag'
  detail: string
  day_number: number | null
  refs: string[]
  leg_m: number | null
}
export type TradeoffOption = { label: string; value: string; pro: string; con: string }
export type TripTradeoffComparison = {
  axis: string
  scope: 'hotel'
  option_a: TradeoffOption
  option_b: TradeoffOption
  recommendation: string | null
  refs: string[]
}
export type TripTradeoffs = { notes: TripTradeoffNote[]; comparisons: TripTradeoffComparison[] }

export type TripPlace = {
  id: string
  trip_id: string
  place_id: string
  source_type: PlaceSourceType
  evidence_json: TripPlaceEvidence
  day_number: number | null
  sort_order: number | null
  place: Place                    // joined for convenience (mock-api pre-joins)
}

export type TripDay = {
  id: string
  trip_id: string
  day_number: number
  day_date: string | null         // ISO date
  title: string | null
  summary: string | null
  weather_summary: string | null
  weather_source: 'open_meteo' | 'manual' | 'none' | null
  weather_payload: Record<string, unknown>
}

export type TransportLeg = {
  id: string
  trip_id: string
  trip_day_id: string | null
  from_place_id: string | null
  to_place_id: string | null
  leg_order: number
  transport_mode: TransportMode
  routing_provider: 'mapbox' | 'manual' | 'none'
  routing_profile: RoutingProfile | null
  status: TransportStatus
  duration_seconds: number | null
  distance_meters: number | null
  route_geometry: GeoJSON.LineString | null  // jsonb in DB; narrowed to Mapbox Directions leg geometry
  warning: string | null
}

export type RestaurantSuggestion = {
  id: string
  trip_id: string
  trip_day_id: string | null
  restaurant_place_id: string | null
  near_place_id: string | null
  cuisine: string | null
  summary: string
  source_url: string | null
  evidence_json: Record<string, unknown>
  preference_match_json: Record<string, unknown>
}

export type HotelSuggestion = {
  id: string
  trip_id: string
  trip_day_id: string | null
  base_place_id: string | null
  name: string
  area: string | null
  star_rating: number | null
  price_snapshot: Record<string, unknown>
  travala_hotel_id: string | null
  // travala_session_id, travala_package_id, travala_result_json (DB columns) omitted — backend-only Travala search metadata not consumed by the frontend.
  preference_match_json: Record<string, unknown>
  source: 'travala' | 'manual' | 'agent'
  status: HotelStatus
  searched_at: string | null
}

export type TripInspirationItem = {
  id: string
  trip_id: string
  item_type: InspirationItemType
  source: InspirationSource
  normalized_reel_url: string | null
  reel_cache_id: string | null
  requested_place_text: string | null
  resolved_place_id: string | null
  status: InspirationStatus
  thumbnail_url: string | null    // convenience for the tray (joined from reel_cache)
}

export type GenerationEvent = {
  id: string
  trip_id: string
  event_type: GenerationEventType
  stage: GenerationStage
  message: string
  payload: Record<string, unknown>
  created_at: string
}

export type Trip = {
  id: string
  user_id: string
  status: TripStatus
  destination_hint: string | null
  inferred_destination: string | null
  start_date: string | null
  end_date: string | null
  origin_city: string | null
  budget_level: BudgetLevel | null
  adult_count: number
  child_count: number
  room_count: number
  preference_sources: PreferenceSource[]
  preference_summary: string | null
  title: string | null            // generated trip title (narrator) — backend narration output
  summary: string | null          // read-only orchestrator summary (narrator)
  tradeoffs: TripTradeoffs         // deterministic notes + hotel comparisons (backend emission)
  created_at: string
  updated_at: string
}

// Everything the trip view needs in one shot (mock-api pre-joins; later a Supabase view/RPC).
export type TripBundle = {
  trip: Trip
  inspiration: TripInspirationItem[]
  places: TripPlace[]
  days: TripDay[]
  transport_legs: TransportLeg[]
  restaurants: RestaurantSuggestion[]
  hotels: HotelSuggestion[]
  events: GenerationEvent[]
  /* Places referenced BY suggestions (restaurant_place_id, near_place_id) but which
     are not themselves stops on the trip. Without these the restaurant strip cannot
     resolve a name and every card read "Suggested spot". Frontend-only aggregate —
     TripBundle has no Pydantic mirror; it is assembled here from separate queries. */
  suggestion_places: Place[]
}

export type TravelerProfile = {
  id: string
  origin_city: string | null
  travel_style_tags: string[]
  preference_tags: string[]
  preference_notes: string | null
  onboarding_completed: boolean
}

export type UserPreferenceFact = {
  id: string
  user_id: string
  category: string
  fact_key: string
  fact_value: unknown
  source: 'onboarding' | 'explicit_input' | 'generation' | 'feedback' | 'mem0' | 'manual'
  confidence: number
  status: 'active' | 'superseded' | 'rejected' | 'deleted'
}

// ---- SSE stream types (preserve the existing envelope) ----
export type StageEvent = {
  type: 'stage'
  stage: GenerationStage
  msg: string
}
export type HeartbeatEvent = { type: 'heartbeat'; elapsed_s: number }
export type ResultEvent = { type: 'result'; content: string }
export type NoticeEvent = {
  type: 'warning' | 'error' | 'decision'
  stage: GenerationStage
  msg: string
}
export type StreamEvent = StageEvent | HeartbeatEvent | ResultEvent | NoticeEvent

// ---- Request/response for the pipeline endpoint ----
export type GenerateTripRequest = {
  reel_urls: string[]
  place_ids?: string[]
  requested_places: string[]
  destination_hint: string | null
  start_date: string   // required — pipeline date-range needs real dates
  end_date: string     // required — pipeline date-range needs real dates
  budget_level: BudgetLevel | null
  origin_city: string | null
  preferences: string | null
  /** Mirrors backend GenerateTripRequest.pace (api/schemas.py). Deliberately `string`, not a
   *  union: the backend caps length rather than enumerating values, so an unrecognized pace
   *  is accepted (no breaking 422) — the TS type must not be stricter than the API. */
  pace?: string
}
export type GenerateTripResponse = { trip_id: string }

/** Mirror of backend api/errors.py ErrorResponse. Every API error returns this shape. */
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}
