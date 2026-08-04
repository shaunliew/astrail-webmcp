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
export type UserPlan = 'trial' | 'beta'   // users.plan CHECK constraint (free trial vs beta seat)
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

// --- Settings: mem0 preference memory (mirrors api/schemas.py) ---
// Deliberately NOT UserPreferenceFact: mem0 returns prose, not structured facts, and
// synthesising fact_key/confidence to fit that type would be inventing data.
// These are STORED memories — not identical to what a given generation recalls.
export type MemoryStatus = 'ok' | 'disabled' | 'unavailable'
export type MemoryFact = { id: string; memory: string; created_at: string; source: 'mem0' }
export type SettingsPreferencesResponse = { status: MemoryStatus; facts: MemoryFact[] }

// POST /settings/memory/clear — success only; failures use ErrorResponse above with
// one of these codes. `unavailable` means nothing was deleted (safe to retry);
// `unknown` means the outcome could not be verified (do not retry blindly).
export type MemoryClearResponse = { cleared: true }
export type MemoryClearErrorCode = 'memory_unavailable' | 'memory_clear_unknown'
// Stable slugs the clear-memory UI branches on (never message strings). `memory_unavailable`
// (503) = nothing was deleted, safe to retry / couldn't reach the service; `memory_clear_unknown`
// = attempted but the outcome could not be confirmed. While the reconciliation gate is off the
// backend returns memory_unavailable, so the button honestly shows "couldn't reach" until go-live.
export const ERROR_CODE_MEMORY_UNAVAILABLE = 'memory_unavailable' as const
export const ERROR_CODE_MEMORY_CLEAR_UNKNOWN = 'memory_clear_unknown' as const

// POST /trips/:tripId/feedback — mirrors backend/api/schemas.py TripFeedback*.
// Trip-level only; artifact_type is always 'trip' in v1. The backend does NOT accept
// artifact_type/artifact_id from the client, so they are absent from the request type.
export type TripFeedbackType =
  | 'rating'
  | 'thumbs_up'
  | 'thumbs_down'
  | 'correction'
  | 'free_text'

export type TripFeedbackRequest = {
  feedback_type: TripFeedbackType
  rating?: number | null
  comment?: string | null
}

export type TripFeedback = {
  id: string
  trip_id: string
  artifact_type: 'trip'
  feedback_type: TripFeedbackType
  rating: number | null
  comment: string | null
}

export type TripFeedbackResponse = { feedback: TripFeedback }

// --- Entitlements: free trial + beta seats (mirrors backend main.py / api/schemas.py) ---
// Error `code` values carried by the {"error":{"code","message"}} envelope (api.ts ApiError).
// Values MUST match the backend HTTPException details verbatim — they are the branch keys the
// UI classifies on (e.g. classifyGenerateError → TrialExhaustedCard).
export const ERROR_CODE_TRIAL_EXHAUSTED = 'trial_exhausted' as const       // 403 — free trip already spent
export const ERROR_CODE_IDENTITY_UNAVAILABLE = 'identity_unavailable' as const  // 503 — missing users row
export const ERROR_CODE_RATE_LIMITED = 'rate_limited' as const             // 429 — daily/burst limit
export const ERROR_CODE_CONFLICT_RETRY = 'conflict_retry' as const         // 409 — reservation raced, retry

// Mirror of backend RequestSeatResponse (Pydantic: requested_at: datetime → ISO string on the wire).
// POST /request-seat returns {"requested_at": "<iso>"}; idempotent (repeat clicks return the original stamp).
export type RequestSeatResponse = { requested_at: string }

// The `jobs` charge columns (charge_kind / charge_date / charge_refunded_at) are backend-only
// entitlement bookkeeping (plan L813) — no frontend row mirror.

// --- Account deletion: self-serve 7-day grace (mirrors backend api/schemas.py + main.py) ---
// `users.account_status` CHECK constraint (supabase migration, Task 2). A pending/deleting
// account is inside the 7-day cancellable grace; `deleting` is the sweeper's atomic point of no
// return (Task 3) and can no longer be cancelled.
export type AccountStatus = 'active' | 'pending_deletion' | 'deleting'

// Mirror of backend AccountDeletionResponse (Pydantic: scheduled_for: datetime → ISO string on
// the wire). POST /account/deletion success body — the account entered the grace; `scheduled_for`
// is the date shown to the user + named in the "deletion scheduled" email (Task 4). Failures use
// ErrorResponse: 503 deletion_unavailable (gated off / migration lag), 409 deletion_not_active.
export type AccountDeletionResponse = { scheduled_for: string }

// Mirror of backend AccountDeletionCancelResponse (Pydantic Literal[True]). POST
// /account/deletion/cancel success body. Failures use ErrorResponse: 503 deletion_unavailable,
// 409 deletion_already_started (sweeper claimed it → status `deleting`) or no_pending_deletion.
export type AccountDeletionCancelResponse = { cancelled: true }

// Error `code` values on the {"error":{"code","message"}} envelope for the deletion endpoints
// (backend main.py HTTPException details). The UI branches on these to react distinctly.
export const ERROR_CODE_DELETION_UNAVAILABLE = 'deletion_unavailable' as const         // 503 — gated off / migration lag
export const ERROR_CODE_DELETION_NOT_ACTIVE = 'deletion_not_active' as const            // 409 — account not 'active' (already pending/deleting)
export const ERROR_CODE_DELETION_ALREADY_STARTED = 'deletion_already_started' as const  // 409 — sweeper claimed it, can no longer cancel
export const ERROR_CODE_NO_PENDING_DELETION = 'no_pending_deletion' as const            // 409 — nothing pending to cancel
