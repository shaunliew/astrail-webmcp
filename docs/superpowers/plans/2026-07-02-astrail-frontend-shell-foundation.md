# Astrail Frontend Shell — Plan 1 of 5: Foundation (Data + Auth + Test Harness)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the swappable data/auth foundation the entire hardcoded frontend shell renders from — DB-shaped types, a canonical Tokyo trip fixture, a mock-api behind the real backend function signatures, a `NEXT_PUBLIC_MOCK_AUTH` bypass, and the Vitest test harness the frontend currently lacks.

**Architecture:** Every screen reads through `lib/trip/mock-api.ts`, which returns DB-shaped typed objects and (for generation) replays SSE-shaped events on a timer. No component imports a fixture directly. When Shaun's FastAPI backend lands, only `mock-api.ts` internals and `api.ts` change — types and components stay put.

**Tech Stack:** Next.js 15 (App Router) · React 19 · TypeScript 5.9 · Tailwind v4 · Vitest + @testing-library/react + jsdom.

## Global Constraints

- Frontend package manager: `npm` (there is a `frontend/package-lock.json`). All commands run from `frontend/`.
- Types mirror the Supabase migration columns **verbatim in snake_case** (frontend reads Supabase directly per `.claude/CLAUDE.md`). Source of truth: `supabase/migrations/*.sql`.
- Reuse existing brand tokens from `frontend/app/globals.css` (`--void`, `--deep`, `--elevated`, `--starlight`, `--muted`, `--faint`, `--brass`, `--line`). Never introduce new raw hex in components.
- Fonts are wired in `frontend/app/layout.tsx` as CSS vars: `--font-instrument-serif` (display), `--font-geist` (body), `--font-jetbrains-mono` (label). Use `.type-display` / `.type-body` / `.type-label` utilities.
- SSE envelope is non-negotiable (`.claude/CLAUDE.md`): stage events `{"type":"stage","stage":...,"msg":...}`, `{"type":"heartbeat","elapsed_s":...}`, terminate with `{"type":"result","content":"<json>"}` then `[DONE]`.
- `TripStatus` values (PRD §17): `draft | generating | places_ready | complete | saved_with_gaps | failed`.
- `PlaceSourceType` values (PRD §11): `reel_extracted | user_requested | agent_suggested`.
- Anti-hallucination (PRD §12): every place carries `lat`, `lng`, evidence, `confidence`, `source_url` — the fixture must satisfy this.
- Icons: SVG only (Lucide-style inline SVG or a small icon module). No emoji as structural icons.
- `NEXT_PUBLIC_MOCK_AUTH=true` must make the whole `/app/*` shell reachable with zero backend; real Supabase auth code stays intact behind the flag.

---

## File Structure

- `frontend/vitest.config.ts` — Vitest config (jsdom env, React plugin, path alias `@/`).
- `frontend/vitest.setup.ts` — Testing Library matchers + jsdom shims.
- `frontend/lib/trip/backend-types.ts` — **rewrite** to DB-shaped snake_case types (the frozen draft contract).
- `frontend/lib/trip/fixtures/tokyo-trip.ts` — the one canonical trip (places, days, legs, restaurants, hotel, inspiration items, generation events) incl. one baked partial failure.
- `frontend/lib/trip/fixtures/traveler.ts` — mock traveler profile + preference facts + daily usage.
- `frontend/lib/trip/fixtures/index.ts` — barrel re-export of the fixtures.
- `frontend/lib/trip/mock-api.ts` — `getTrip`, `listTrips`, `getProfile`, `submitFeedback`, `streamGeneration` behind real signatures.
- `frontend/lib/auth/mock-auth.ts` — `MOCK_AUTH_ENABLED`, `MOCK_USER`, `getMockSession()`.
- `frontend/lib/auth/use-user.ts` — `useUser()` client hook (mock-aware, falls back to Supabase).
- `frontend/middleware.ts` — **modify** to short-circuit when `NEXT_PUBLIC_MOCK_AUTH=true`.
- `frontend/.env.local` — **modify** to add `NEXT_PUBLIC_MOCK_AUTH=true` (dev only).
- `frontend/package.json` — **modify** scripts + devDependencies.

---

## Task 1: Add the Vitest test harness

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/vitest.config.ts`
- Create: `frontend/vitest.setup.ts`
- Create: `frontend/lib/trip/__tests__/harness.test.ts`

**Interfaces:**
- Produces: `npm test` (Vitest run) and `npm run test:watch`; a working `@/` path alias in tests; `jsdom` DOM env for component tests in later plans.

- [ ] **Step 1: Install dev dependencies**

Run (from `frontend/`):
```bash
npm install -D vitest@^2.1.0 @vitejs/plugin-react@^4.3.0 jsdom@^25.0.0 @testing-library/react@^16.0.0 @testing-library/jest-dom@^6.5.0 @testing-library/user-event@^14.5.0
```
Expected: packages added to `devDependencies`, no peer-dep errors (React 19 is supported by @testing-library/react 16).

- [ ] **Step 2: Add test scripts to `package.json`**

In `frontend/package.json`, add to `"scripts"`:
```json
    "test": "vitest run",
    "test:watch": "vitest"
```

- [ ] **Step 3: Create `frontend/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
  },
})
```

- [ ] **Step 4: Create `frontend/vitest.setup.ts`**

```ts
import '@testing-library/jest-dom/vitest'
```

- [ ] **Step 5: Write the harness smoke test**

Create `frontend/lib/trip/__tests__/harness.test.ts`:
```ts
import { describe, it, expect } from 'vitest'

describe('test harness', () => {
  it('runs and resolves the @/ alias', async () => {
    const mod = await import('@/lib/trip/sse')
    expect(typeof mod.parseSSEChunk).toBe('function')
  })
})
```

- [ ] **Step 6: Run the test**

Run: `npm test`
Expected: PASS — 1 passed. Confirms Vitest, jsdom, and the `@/` alias all work.

- [ ] **Step 7: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/vitest.config.ts frontend/vitest.setup.ts frontend/lib/trip/__tests__/harness.test.ts
git commit -m "test(frontend): add vitest + testing-library harness"
```

---

## Task 2: Rewrite `backend-types.ts` to DB-shaped snake_case types

**Files:**
- Modify (full rewrite): `frontend/lib/trip/backend-types.ts`
- Test: `frontend/lib/trip/__tests__/backend-types.test.ts`

**Interfaces:**
- Produces (imported by every later task): `TripStatus`, `BudgetLevel`, `PlaceSourceType`, `TransportStatus`, `RoutingProfile`, `TransportMode`, `Place`, `TripPlace`, `TripDay`, `TransportLeg`, `RestaurantSuggestion`, `HotelSuggestion`, `TripInspirationItem`, `GenerationEvent`, `Trip`, `TripBundle`, `TravelerProfile`, `UserPreferenceFact`, `PreferenceSource`, `EvidenceKind`. Plus preserved stream types: `StageEvent`, `HeartbeatEvent`, `ResultEvent`, `StreamEvent`, and updated `GenerateTripRequest` / `GenerateTripResponse`.

- [ ] **Step 1: Write the failing test**

Create `frontend/lib/trip/__tests__/backend-types.test.ts`:
```ts
import { describe, it, expectTypeOf } from 'vitest'
import type {
  Trip, Place, TripDay, TransportLeg, TripBundle, StageEvent, GenerationEvent,
} from '@/lib/trip/backend-types'

describe('backend-types contract', () => {
  it('Trip.status is the frozen union', () => {
    expectTypeOf<Trip['status']>().toEqualTypeOf<
      'draft' | 'generating' | 'places_ready' | 'complete' | 'saved_with_gaps' | 'failed'
    >()
  })
  it('Place carries anti-hallucination fields', () => {
    expectTypeOf<Place['lat']>().toBeNumber()
    expectTypeOf<Place['lng']>().toBeNumber()
  })
  it('TransportLeg.status matches the DB check', () => {
    expectTypeOf<TransportLeg['status']>().toEqualTypeOf<
      'pending' | 'ok' | 'no_route' | 'failed' | 'skipped'
    >()
  })
  it('TripBundle aggregates the trip output', () => {
    expectTypeOf<TripBundle['trip']>().toEqualTypeOf<Trip>()
    expectTypeOf<TripBundle['days']>().toEqualTypeOf<TripDay[]>()
  })
  it('StageEvent and GenerationEvent both exist', () => {
    expectTypeOf<StageEvent['type']>().toEqualTypeOf<'stage'>()
    expectTypeOf<GenerationEvent['event_type']>().toBeString()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- backend-types`
Expected: FAIL — types don't exist yet / current file has no `Trip`, `Place`, `TripBundle`.

- [ ] **Step 3: Rewrite `frontend/lib/trip/backend-types.ts`**

```ts
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
  quote: string | null            // verbatim reel/user quote (PRD §11/§12)
  rationale: string | null        // agent_suggested rationale
  evidence_kind: EvidenceKind
}

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
  route_geometry: GeoJSON.LineString | null
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
  stage: Exclude<GenerationStage, never>
  msg: string
}
export type HeartbeatEvent = { type: 'heartbeat'; elapsed_s: number }
export type ResultEvent = { type: 'result'; content: string }
export type StreamEvent = StageEvent | HeartbeatEvent | ResultEvent

// ---- Request/response for the pipeline endpoint ----
export type GenerateTripRequest = {
  reel_urls: string[]
  requested_places: string[]
  destination_hint: string | null
  start_date: string | null
  end_date: string | null
  budget_level: BudgetLevel | null
  origin_city: string | null
  preferences: string | null
}
export type GenerateTripResponse = { trip_id: string }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- backend-types`
Expected: PASS — 5 passed.

- [ ] **Step 5: Fix the now-broken existing imports (compile gate)**

`app/app/page.tsx`, `components/trip/ReelInputPanel.tsx`, `components/trip/GenerationTimeline.tsx`, `lib/trip/api.ts` reference the old `GenerateTripRequest` (`reelUrls`, `startDate`…) and old `StageEvent`. These screens are replaced in Plans 2–3. For now, keep the build green by leaving `api.ts` typed against the new `GenerateTripRequest`/`GenerateTripResponse` (field names changed) — update `api.ts` body:

In `frontend/lib/trip/api.ts`, no logic change is needed (it already passes `req` through), but confirm it still compiles against the new types:
```bash
npm run typecheck
```
Expected: errors ONLY in `app/app/page.tsx` and `components/trip/ReelInputPanel.tsx` (old field names). These files are rewritten in Plan 3. To keep this task's commit green, revert `app/app/page.tsx` to a minimal placeholder:

Replace `frontend/app/app/page.tsx` entire contents:
```tsx
export default function AppHomePlaceholder() {
  // Replaced in Plan 3 (Inspiration Tray). Kept minimal so the build stays green.
  return null
}
```
And replace `frontend/components/trip/ReelInputPanel.tsx` entire contents:
```tsx
// Replaced in Plan 3 (Inspiration Tray).
export default function ReelInputPanel() {
  return null
}
```

- [ ] **Step 6: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exit 0, no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/lib/trip/backend-types.ts frontend/lib/trip/__tests__/backend-types.test.ts frontend/app/app/page.tsx frontend/components/trip/ReelInputPanel.tsx
git commit -m "feat(frontend): DB-shaped snake_case type contract for trip data"
```

---

## Task 3: Build the canonical Tokyo trip fixture

**Files:**
- Create: `frontend/lib/trip/fixtures/tokyo-trip.ts`
- Create: `frontend/lib/trip/fixtures/index.ts`
- Test: `frontend/lib/trip/__tests__/tokyo-trip.test.ts`

**Interfaces:**
- Consumes: all row types from `backend-types.ts`.
- Produces: `TOKYO_TRIP: TripBundle` (exported from `fixtures/tokyo-trip.ts` and re-exported from `fixtures/index.ts`). Trip id `'trip_tokyo_demo'`, user id `'demo-user'`.

- [ ] **Step 1: Write the failing test (encodes PRD invariants)**

Create `frontend/lib/trip/__tests__/tokyo-trip.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { TOKYO_TRIP } from '@/lib/trip/fixtures/tokyo-trip'

describe('Tokyo fixture invariants', () => {
  it('is a complete, saved-with-gaps trip', () => {
    expect(TOKYO_TRIP.trip.id).toBe('trip_tokyo_demo')
    expect(TOKYO_TRIP.trip.status).toBe('saved_with_gaps')
  })

  it('every place has valid coords + evidence + confidence (PRD §12)', () => {
    expect(TOKYO_TRIP.places.length).toBeGreaterThanOrEqual(4)
    for (const tp of TOKYO_TRIP.places) {
      expect(tp.place.lat).toBeGreaterThanOrEqual(-90)
      expect(tp.place.lat).toBeLessThanOrEqual(90)
      expect(tp.place.lng).toBeGreaterThanOrEqual(-180)
      expect(tp.place.lng).toBeLessThanOrEqual(180)
      expect(tp.evidence_json.confidence).toBeGreaterThan(0)
      expect(tp.evidence_json.evidence_kind).toBeTruthy()
    }
  })

  it('covers all three source types (PRD §11)', () => {
    const kinds = new Set(TOKYO_TRIP.places.map((p) => p.source_type))
    expect(kinds.has('reel_extracted')).toBe(true)
    expect(kinds.has('user_requested')).toBe(true)
    expect(kinds.has('agent_suggested')).toBe(true)
  })

  it('has a baked partial failure: one no_route leg + one skipped hotel (PRD §17)', () => {
    expect(TOKYO_TRIP.transport_legs.some((l) => l.status === 'no_route')).toBe(true)
    expect(TOKYO_TRIP.hotels.some((h) => h.status === 'skipped')).toBe(true)
  })

  it('days are date-backed and carry weather (PRD §15)', () => {
    expect(TOKYO_TRIP.days.length).toBeGreaterThanOrEqual(2)
    expect(TOKYO_TRIP.days[0].day_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(TOKYO_TRIP.days[0].weather_summary).toBeTruthy()
  })

  it('has a decision timeline (generation_events)', () => {
    expect(TOKYO_TRIP.events.length).toBeGreaterThanOrEqual(5)
    expect(TOKYO_TRIP.events.some((e) => e.event_type === 'decision')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tokyo-trip`
Expected: FAIL — `Cannot find module .../fixtures/tokyo-trip`.

- [ ] **Step 3: Create `frontend/lib/trip/fixtures/tokyo-trip.ts`**

```ts
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
  id, name, place_type, lat, lng,
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
  created_at: '2026-08-01T09:00:00Z', updated_at: '2026-08-01T09:03:00Z',
}

const tp = (
  id: string, p: Place, source_type: TripPlace['source_type'],
  ev: TripPlace['evidence_json'], day_number: number, sort_order: number,
): TripPlace => ({
  id, trip_id: TRIP_ID, place_id: p.id, source_type,
  evidence_json: ev, day_number, sort_order, place: p,
})

const places: TripPlace[] = [
  tp('tp_senso', P.senso, 'reel_extracted', {
    confidence: 0.94, source_url: 'https://www.instagram.com/reel/AAA/',
    quote: 'you HAVE to see Senso-ji at sunrise', rationale: null, evidence_kind: 'reel_quote',
  }, 1, 0),
  tp('tp_teamlab', P.teamlab, 'reel_extracted', {
    confidence: 0.9, source_url: 'https://www.instagram.com/reel/BBB/',
    quote: 'teamLab Planets is unreal 🌊', rationale: null, evidence_kind: 'reel_quote',
  }, 1, 1),
  tp('tp_shibuya', P.shibuya, 'reel_extracted', {
    confidence: 0.88, source_url: 'https://www.instagram.com/reel/CCC/',
    quote: 'Shibuya Sky at golden hour', rationale: null, evidence_kind: 'reel_quote',
  }, 2, 0),
  tp('tp_ichiran', P.ichiran, 'agent_suggested', {
    confidence: 0.8, source_url: 'https://ichiran.com/', quote: null,
    rationale: 'Ramen near Shibuya Sky matching your ramen + walkable preference.',
    evidence_kind: 'suggested_by_astrail',
  }, 2, 1),
  tp('tp_disney', P.disney, 'user_requested', {
    confidence: 1, source_url: null, quote: 'Also want to go Tokyo Disneyland',
    rationale: null, evidence_kind: 'requested_by_you',
  }, 3, 0),
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
    weather_summary: null, weather_source: 'none', weather_payload: {},
  },
]

const leg = (
  id: string, day: string, from: string, to: string, order: number,
  status: TransportLeg['status'], mode: TransportLeg['transport_mode'],
  profile: TransportLeg['routing_profile'], dur: number | null, dist: number | null,
  warning: string | null,
): TransportLeg => ({
  id, trip_id: TRIP_ID, trip_day_id: day, from_place_id: from, to_place_id: to,
  leg_order: order, transport_mode: mode, routing_provider: profile ? 'mapbox' : 'none',
  routing_profile: profile, status, duration_seconds: dur, distance_meters: dist,
  route_geometry: status === 'ok'
    ? { type: 'LineString', coordinates: [[P.senso.lng, P.senso.lat], [P.teamlab.lng, P.teamlab.lat]] }
    : null,
  warning,
})

const transport_legs: TransportLeg[] = [
  leg('leg_1', 'day_1', 'pl_senso', 'pl_teamlab', 0, 'ok', 'drive', 'driving', 1500, 9200, null),
  leg('leg_2', 'day_2', 'pl_shibuya', 'pl_ichiran', 0, 'ok', 'walk', 'walking', 240, 300, null),
  // Baked partial failure (PRD §17): no route to Disneyland.
  leg('leg_3', 'day_3', 'pl_shibuya', 'pl_disney', 0, 'no_route', 'transit_hint', null, null, null,
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
    id: 'hotel_1', trip_id: TRIP_ID, trip_day_id: null, base_place_id: 'pl_hotelbase',
    name: 'Shinjuku Granbell Hotel', area: 'Shinjuku', star_rating: 4,
    price_snapshot: { currency: 'USD', nightly: 128 }, travala_hotel_id: 'tv_12345',
    preference_match_json: { matched: ['central', 'mid_range'] },
    source: 'travala', status: 'suggested', searched_at: '2026-08-01T09:02:30Z',
  },
  // Baked partial failure (PRD §17): a skipped hotel search.
  {
    id: 'hotel_2', trip_id: TRIP_ID, trip_day_id: 'day_3', base_place_id: null,
    name: 'Near Tokyo Disneyland', area: 'Urayasu', star_rating: null,
    price_snapshot: {}, travala_hotel_id: null, preference_match_json: {},
    source: 'travala', status: 'skipped', searched_at: null,
  },
]

const inspiration: TripInspirationItem[] = [
  {
    id: 'insp_1', trip_id: TRIP_ID, item_type: 'reel_url', source: 'manual_paste',
    normalized_reel_url: 'https://www.instagram.com/reel/AAA/', reel_cache_id: 'rc_1',
    requested_place_text: null, resolved_place_id: 'pl_senso', status: 'places_found',
    thumbnail_url: '/reference/YAAY-showing-proof-of-extraction.jpg',
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
}
```

- [ ] **Step 4: Create `frontend/lib/trip/fixtures/index.ts`**

```ts
export { TOKYO_TRIP } from './tokyo-trip'
export { DEMO_PROFILE, DEMO_PREFERENCE_FACTS } from './traveler'
```

Note: `traveler.ts` is created in Task 4; if implementing tasks strictly in order, add the `traveler` re-export line in Task 4 Step 3 instead. Leave only the `TOKYO_TRIP` export here until then.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tokyo-trip`
Expected: PASS — 6 passed.

- [ ] **Step 6: Commit**

```bash
git add frontend/lib/trip/fixtures/tokyo-trip.ts frontend/lib/trip/fixtures/index.ts frontend/lib/trip/__tests__/tokyo-trip.test.ts
git commit -m "feat(frontend): canonical Tokyo trip fixture with baked partial failure"
```

---

## Task 4: Build the traveler profile fixture

**Files:**
- Create: `frontend/lib/trip/fixtures/traveler.ts`
- Modify: `frontend/lib/trip/fixtures/index.ts`
- Test: `frontend/lib/trip/__tests__/traveler.test.ts`

**Interfaces:**
- Consumes: `TravelerProfile`, `UserPreferenceFact` from `backend-types.ts`.
- Produces: `DEMO_PROFILE: TravelerProfile`, `DEMO_PREFERENCE_FACTS: UserPreferenceFact[]`.

- [ ] **Step 1: Write the failing test**

Create `frontend/lib/trip/__tests__/traveler.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { DEMO_PROFILE, DEMO_PREFERENCE_FACTS } from '@/lib/trip/fixtures/traveler'

describe('traveler fixture', () => {
  it('has a completed onboarding profile', () => {
    expect(DEMO_PROFILE.id).toBe('demo-user')
    expect(DEMO_PROFILE.onboarding_completed).toBe(true)
    expect(DEMO_PROFILE.preference_tags.length).toBeGreaterThan(0)
  })
  it('has active preference facts for the memory receipt', () => {
    expect(DEMO_PREFERENCE_FACTS.every((f) => f.status === 'active')).toBe(true)
    expect(DEMO_PREFERENCE_FACTS.length).toBeGreaterThanOrEqual(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- traveler`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `frontend/lib/trip/fixtures/traveler.ts`**

```ts
import type { TravelerProfile, UserPreferenceFact } from '@/lib/trip/backend-types'

export const DEMO_PROFILE: TravelerProfile = {
  id: 'demo-user',
  origin_city: 'Kuala Lumpur',
  travel_style_tags: ['food-led', 'walkable', 'relaxed'],
  preference_tags: ['ramen', 'walkable days', 'not too rushed'],
  preference_notes: 'Mid-range budget, avoids rushed itineraries.',
  onboarding_completed: true,
}

const fact = (
  id: string, category: string, fact_key: string, fact_value: unknown,
): UserPreferenceFact => ({
  id, user_id: 'demo-user', category, fact_key, fact_value,
  source: 'onboarding', confidence: 0.9, status: 'active',
})

export const DEMO_PREFERENCE_FACTS: UserPreferenceFact[] = [
  fact('pf_1', 'food', 'likes_cuisine', 'ramen'),
  fact('pf_2', 'pace', 'prefers', 'walkable days'),
  fact('pf_3', 'pace', 'avoids', 'rushed itineraries'),
  fact('pf_4', 'budget', 'style', 'mid_range'),
]
```

- [ ] **Step 4: Update `frontend/lib/trip/fixtures/index.ts`**

Ensure it reads exactly:
```ts
export { TOKYO_TRIP } from './tokyo-trip'
export { DEMO_PROFILE, DEMO_PREFERENCE_FACTS } from './traveler'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- traveler`
Expected: PASS — 2 passed.

- [ ] **Step 6: Commit**

```bash
git add frontend/lib/trip/fixtures/traveler.ts frontend/lib/trip/fixtures/index.ts frontend/lib/trip/__tests__/traveler.test.ts
git commit -m "feat(frontend): demo traveler profile + preference facts fixture"
```

---

## Task 5: Build the mock-api behind real signatures

**Files:**
- Create: `frontend/lib/trip/mock-api.ts`
- Test: `frontend/lib/trip/__tests__/mock-api.test.ts`

**Interfaces:**
- Consumes: `TOKYO_TRIP`, `DEMO_PROFILE`, `DEMO_PREFERENCE_FACTS`; types from `backend-types.ts`.
- Produces:
  - `getTrip(tripId: string): Promise<TripBundle | null>`
  - `listTrips(): Promise<Trip[]>`
  - `getProfile(): Promise<{ profile: TravelerProfile; facts: UserPreferenceFact[] }>`
  - `submitFeedback(input: FeedbackInput): Promise<{ ok: true }>` where `FeedbackInput = { trip_id: string; artifact_type: string; artifact_id: string | null; rating?: number; comment?: string }`
  - `streamGeneration(tripId: string, onEvent: (e: StreamEvent) => void): { cancel: () => void }` — replays scripted SSE events on timers, ends with `result` then simulates `[DONE]` via `onEvent` result; caller closes.
  - `MOCK_LATENCY_MS` constant.

- [ ] **Step 1: Write the failing test**

Create `frontend/lib/trip/__tests__/mock-api.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { getTrip, listTrips, getProfile, submitFeedback, streamGeneration } from '@/lib/trip/mock-api'
import type { StreamEvent } from '@/lib/trip/backend-types'

describe('mock-api', () => {
  it('getTrip returns the Tokyo bundle for the demo id, null otherwise', async () => {
    const bundle = await getTrip('trip_tokyo_demo')
    expect(bundle?.trip.id).toBe('trip_tokyo_demo')
    expect(await getTrip('nope')).toBeNull()
  })

  it('listTrips returns at least the demo trip', async () => {
    const trips = await listTrips()
    expect(trips.some((t) => t.id === 'trip_tokyo_demo')).toBe(true)
  })

  it('getProfile returns the demo profile + facts', async () => {
    const { profile, facts } = await getProfile()
    expect(profile.id).toBe('demo-user')
    expect(facts.length).toBeGreaterThan(0)
  })

  it('submitFeedback resolves ok', async () => {
    const res = await submitFeedback({ trip_id: 'trip_tokyo_demo', artifact_type: 'trip', artifact_id: null, rating: 5 })
    expect(res.ok).toBe(true)
  })

  it('streamGeneration emits stage events then a terminal result', async () => {
    vi.useFakeTimers()
    const events: StreamEvent[] = []
    const handle = streamGeneration('trip_tokyo_demo', (e) => events.push(e))
    await vi.runAllTimersAsync()
    handle.cancel()
    vi.useRealTimers()
    expect(events.some((e) => e.type === 'stage')).toBe(true)
    expect(events.some((e) => e.type === 'heartbeat')).toBe(true)
    expect(events.at(-1)?.type).toBe('result')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- mock-api`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `frontend/lib/trip/mock-api.ts`**

```ts
import type {
  TripBundle, Trip, TravelerProfile, UserPreferenceFact, StreamEvent, StageEvent,
} from '@/lib/trip/backend-types'
import { TOKYO_TRIP, DEMO_PROFILE, DEMO_PREFERENCE_FACTS } from '@/lib/trip/fixtures'

// Simulated network latency so loading/skeleton states are visible in the shell.
export const MOCK_LATENCY_MS = 350

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
  { at: 6200, event: { type: 'result', content: JSON.stringify({ tripId: TOKYO_TRIP.trip.id }) } },
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
```

Note: `stage` values must be members of `StageEvent['stage']`. Since `StageEvent['stage']` equals `GenerationStage`, `scrape`/`extract`/`dedup`/`enrich`/`weather`/`restaurants`/`transport`/`narrate`/`summarize` all typecheck.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- mock-api`
Expected: PASS — 5 passed.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/trip/mock-api.ts frontend/lib/trip/__tests__/mock-api.test.ts
git commit -m "feat(frontend): mock-api behind real backend signatures + scripted SSE"
```

---

## Task 6: Add the mock-auth module and `useUser` hook

**Files:**
- Create: `frontend/lib/auth/mock-auth.ts`
- Create: `frontend/lib/auth/use-user.ts`
- Test: `frontend/lib/auth/__tests__/mock-auth.test.ts`

**Interfaces:**
- Produces:
  - `MOCK_AUTH_ENABLED: boolean` (`process.env.NEXT_PUBLIC_MOCK_AUTH === 'true'`)
  - `MOCK_USER: { id: string; name: string; email: string }`
  - `getMockSession(): { user: typeof MOCK_USER } | null`
  - `useUser(): { user: { id: string; name: string; email: string } | null; loading: boolean }`

- [ ] **Step 1: Write the failing test**

Create `frontend/lib/auth/__tests__/mock-auth.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('mock-auth', () => {
  beforeEach(() => { vi.resetModules() })
  afterEach(() => { delete process.env.NEXT_PUBLIC_MOCK_AUTH })

  it('is disabled by default (no session)', async () => {
    const { MOCK_AUTH_ENABLED, getMockSession } = await import('@/lib/auth/mock-auth')
    expect(MOCK_AUTH_ENABLED).toBe(false)
    expect(getMockSession()).toBeNull()
  })

  it('returns a demo session when the flag is on', async () => {
    process.env.NEXT_PUBLIC_MOCK_AUTH = 'true'
    vi.resetModules()
    const { MOCK_AUTH_ENABLED, getMockSession, MOCK_USER } = await import('@/lib/auth/mock-auth')
    expect(MOCK_AUTH_ENABLED).toBe(true)
    expect(getMockSession()?.user.id).toBe(MOCK_USER.id)
    expect(MOCK_USER.id).toBe('demo-user')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- mock-auth`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `frontend/lib/auth/mock-auth.ts`**

```ts
export const MOCK_AUTH_ENABLED = process.env.NEXT_PUBLIC_MOCK_AUTH === 'true'

export const MOCK_USER = {
  id: 'demo-user',
  name: 'Astronaut',
  email: 'demo@astrail.app',
}

export function getMockSession(): { user: typeof MOCK_USER } | null {
  return MOCK_AUTH_ENABLED ? { user: MOCK_USER } : null
}
```

- [ ] **Step 4: Create `frontend/lib/auth/use-user.ts`**

```ts
'use client'

import { useEffect, useState } from 'react'
import { MOCK_AUTH_ENABLED, MOCK_USER } from '@/lib/auth/mock-auth'
import { createClient } from '@/lib/supabase/client'

type AppUser = { id: string; name: string; email: string }

export function useUser(): { user: AppUser | null; loading: boolean } {
  const [user, setUser] = useState<AppUser | null>(MOCK_AUTH_ENABLED ? MOCK_USER : null)
  const [loading, setLoading] = useState(!MOCK_AUTH_ENABLED)

  useEffect(() => {
    if (MOCK_AUTH_ENABLED) return
    let active = true
    const supabase = createClient()
    supabase.auth.getUser().then(({ data }) => {
      if (!active) return
      setUser(
        data.user
          ? {
              id: data.user.id,
              name:
                (data.user.user_metadata?.full_name as string | undefined) ??
                (data.user.email ?? 'Traveler'),
              email: data.user.email ?? '',
            }
          : null,
      )
      setLoading(false)
    })
    return () => { active = false }
  }, [])

  return { user, loading }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- mock-auth`
Expected: PASS — 2 passed.

- [ ] **Step 6: Commit**

```bash
git add frontend/lib/auth/mock-auth.ts frontend/lib/auth/use-user.ts frontend/lib/auth/__tests__/mock-auth.test.ts
git commit -m "feat(frontend): mock-auth module + mock-aware useUser hook"
```

---

## Task 7: Wire the mock-auth bypass into middleware + env

**Files:**
- Modify: `frontend/middleware.ts:1-42`
- Modify: `frontend/.env.local`

**Interfaces:**
- Consumes: `MOCK_AUTH_ENABLED` from `@/lib/auth/mock-auth`.
- Produces: with `NEXT_PUBLIC_MOCK_AUTH=true`, all `/app/*` routes load without a Supabase session.

- [ ] **Step 1: Modify `frontend/middleware.ts` to short-circuit when mock auth is on**

Replace the file contents with:
```ts
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { MOCK_AUTH_ENABLED } from '@/lib/auth/mock-auth'

export async function middleware(request: NextRequest) {
  // Mock-auth bypass: let the hardcoded shell run with zero backend.
  if (MOCK_AUTH_ENABLED) {
    return NextResponse.next({ request })
  }

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  if (!user && request.nextUrl.pathname.startsWith('/app')) {
    const url = request.nextUrl.clone()
    url.pathname = '/sign-in'
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/app/:path*'],
}
```

- [ ] **Step 2: Add the flag to `frontend/.env.local`**

Append:
```
NEXT_PUBLIC_MOCK_AUTH=true
```

- [ ] **Step 3: Verify typecheck + tests still pass**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; all test files pass.

- [ ] **Step 4: Manual smoke check**

Run: `npm run dev`, open `http://localhost:3000/app`.
Expected: no redirect to `/sign-in` (the page currently renders `null` from the Task 2 placeholder — that's fine; Plan 3 fills it). Confirm no middleware error in the terminal.

- [ ] **Step 5: Commit**

```bash
git add frontend/middleware.ts frontend/.env.local
git commit -m "feat(frontend): NEXT_PUBLIC_MOCK_AUTH bypass in middleware"
```

---

## Self-Review

**Spec coverage:**
- DB-shaped types → Task 2. ✓
- Tokyo fixture with evidence/confidence/coords, 3 source types, partial failure, weather, decision log → Task 3. ✓
- Traveler profile + preference facts (for onboarding/settings/memory receipt) → Task 4. ✓
- mock-api behind real signatures + scripted SSE respecting the envelope → Task 5. ✓
- Mock auth + `useUser` + middleware bypass + env flag → Tasks 6–7. ✓
- Test harness (frontend had none) → Task 1. ✓
- Reuse brand tokens / snake_case contract / SSE envelope → Global Constraints, enforced in fixtures + mock-api. ✓

**Placeholder scan:** The only intentional `return null` placeholders (Task 2 Step 5) exist solely to keep the build green; Plan 3 replaces them. No `TODO`/`TBD` in shipped code.

**Type consistency:** `getTrip`/`listTrips`/`getProfile`/`submitFeedback`/`streamGeneration` signatures in Task 5 match the `mock-api.test.ts` usage and the `TripBundle`/`Trip`/`TravelerProfile` shapes from Task 2. `StageEvent['stage']` = `GenerationStage`, so all scripted stage names typecheck. `MOCK_USER.id` = `'demo-user'` matches the fixture `user_id` in Tasks 3–4.

**Out of scope (later plans):** map component (Plan 2), all screens/components (Plans 2–5), replacing the old `api.ts`/`sse.ts` wiring for the real backend (post-shell).

---

## Downstream plans (to be written next, one per screen group)

- **Plan 2 — Map-first trip view:** `TripMap.tsx` (Mapbox GL globe→city fly-to, pins, route layers), bottom-sheet/side-panel shell, place cards, day selector, place intel panel, restaurant/transport/hotel strips, agent decision timeline, evidence chips. Reads `getTrip('trip_tokyo_demo')`.
- **Plan 3 — Inspiration Tray + Trip Brief + Generation:** paste/clipboard reel parsing into inspiration cards, Trip Brief confirm, `streamGeneration` timeline → route to trip view.
- **Plan 4 — Onboarding wizard:** Yaay-style step wizard writing a mock traveler profile.
- **Plan 5 — Trip list + Settings:** `/app/trips` grid via `listTrips`, `/app/settings` preference summary + memory receipt + clear-memory (mock).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-02-astrail-frontend-shell-foundation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
