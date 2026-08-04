# Plan — Hotel-Hub Map (Travala hotels as a central map pin)

> Status: DRAFT → pending `/plan-eng-review` + Codex. Owner lanes: backend (Shaun), frontend (Zhi Hao).
> Scoped from a 2026-08-04 brainstorm + two research passes (Travala geo, Mapbox Matrix, execution seams). Memory: `[[hotel-hub-map-feature]]`.

## Goal

Put Travala hotels on the Mapbox map as a **single central "parent hub" pin per trip** that branches (straight-line spokes) to the reel place pins (children). The pipeline shortlists the **top 3** hotels by a blended **preference × route-efficiency** score; the user picks one of the 3; the selected hotel becomes the hub and its spokes render. A **toggle** switches the map between the existing itinerary route line and the hotel hub-and-spokes view (never both at once). Selection + toggle are **ephemeral client state** for v1.

## Why (problem)

Travala returns **no coordinates**, so hotels currently dead-end as coordinate-less `hotel_suggestions` rows shown list-only in `HotelPanel` (`persist.py:851` hardcodes `base_place_id=None`, comment: *"Travala returns no coords"*). Users can't see where a hotel sits relative to their spots, and can't tell which hotel is actually central. This feature makes "we found you the most central hotel" real and visible.

## Key facts (verified this session — do not re-litigate)

- **Travala hides a real street address.** `travala_search_hotel` returns **two** content blocks; `backend/genagents/hotel.py:68` only parses `content[0]` (compact). `content[1]` carries a real street `address` (e.g. `"2-7-2 Nishi-Shinjuku"`) we discard today. No coordinates exist anywhere in Travala's surface (8 tools, verified live).
- **We already geocode.** `backend/geocode/mapbox_forward.py` `forward_geocode(query, types=..., proximity_lng_lat=...)` + `apply_geocode()` return real lat/lng via Mapbox Search Box. Default `types="poi"`; for a street address we pass **`types="address"`**. Uses `MAPBOX_SECRET_TOKEN`; absent → warns + degrades (pattern at `capture.py:220`).
- **Ordering is safe.** `persist_itinerary` (`runner.py:382`) persists `places` rows with lat/lng **before** the concurrent gather (`runner.py:490`) that runs `_stage_transport`/`_stage_restaurants`/`_stage_hotels`/`_stage_narration`. So `_stage_hotels` (`runner.py:465` → `persist_hotels`, `persist.py:801`) can read place coords.
- **City string.** `persist_hotels` already resolves `location` = first non-null `places.city` else `trip.destination_hint` (`persist.py:827-832`). This is the geocode city suffix.
- **Read path is client-side Supabase.** No backend bundle endpoint / no Pydantic bundle model. `getTrip()` (`frontend/lib/trip/supabase-api.ts:47`) does `hotel_suggestions.select('*')` (`:61`) → `bundle.hotels: HotelSuggestion[]`. New columns flow automatically; only the TS type + fixtures need updating.
- **Matrix confirmed.** Mapbox Matrix API: 25-coord cap (driving/walking/cycling), `sources`/`destinations` index arrays, `annotations=duration,distance`. At ≤3 hotels × ≤8 places we're well under the cap.
- **Map seams.** `TripMap.tsx`: `drawMarkers()` (`:55`, iterates `bundle.places`), `drawTrail()` (`:89`), teardown via `clearRoutes()`/`routeIdsRef` (`:24`). Shared state colocated in `TripWorkspace.tsx` (`bundle` `:61`, `activeDayNumber` `:63`, `selectedPlaceId` `:64`); `TripMap` rendered `:155`, `HotelPanel` `:257`. `HotelPanel.tsx` is presentational (no onClick today, `:10`/`:23`). Reserved hooks: `TripMap.tsx:87-88`, `selectors.ts:61-63`.

## Locked design decisions

1. **Render from `bundle.hotels`, NOT from `places`/`trip_places` rows** — but do NOT break the existing base-hotel place path. Store `lat`/`lng` **directly on `hotel_suggestions`**; the frontend reads the 3 candidates and draws only the **selected** hotel's hub pin. `bundle.hotels` is the right primary source (3 ephemeral candidates can't switch cleanly if persisted as 3 `trip_places`). **[CODEX-FOLD C2]** Codex confirmed the reserved path is already live in tests: the fixture's undayed `pl_hotelbase` place (`tokyo-trip.ts:98`) drives the `constellation-pin--receding` assertion (`TripMap.test.tsx:217`, via `drawMarkers` rendering all `bundle.places` at `TripMap.tsx:63`). So we **coexist, not replace**: **route mode** keeps the existing place-pin rendering untouched (receding base-hotel behavior + its test survive); **hub mode** renders exactly one hub from `bundle.hotels` AND **suppresses any place marker whose place is a hotel base** (matched by `place_type='hotel'` / a hotel's `base_place_id`) to avoid a duplicate pin. New Travala candidates still don't get `places` rows (`base_place_id` stays NULL); `places`-row linking deferred until routed hotel→place legs. Add tests for BOTH modes; never delete the existing receding-pin test.
2. **Straight-line spokes** (hub → each ordered place). Real routed polylines deferred (would cost a Directions call per spoke).
3. **Layer toggle**, never both layers at once. Default = itinerary route (preserves today's behavior).
4. **Ephemeral** selection + toggle (client state only). No DB write, no new endpoint. Resets to recommended #1 on reload. Persistence is a clean additive later add.
5. **"Pick" model.** Geocode all placeable hotels; if `placeable_hotels + places > 25`, trim lowest-preference hotels to fit the Matrix cap; rank by blended **preference × centrality**; take **top 3**; rank #1 = `is_recommended`.
6. **Preference side is a proxy for v1** (star_rating + price fit), NOT mem0 taste — `preference_match_json` is unwritten today (`persist.py` relies on the `{}` default). mem0-driven hotel preference blend is deferred (trigger: productionizing taste-based hotel ranking). **[This is the biggest scope simplification — flag to CEO/eng review.]**
7. **Honest-failure (HARD constraint, Guardrail #1).** Geocode miss / out-of-proximity / low confidence → **no coords, `geo_status='unresolved'`**, hotel stays list-only with a *"couldn't place this hotel on the map"* note. **Never invent a coordinate.** If Matrix fails but geocode succeeded → hotel is `placed` (spokes drawable) but `route_score`=NULL (ranked by preference only). `<3` placeable → rank only placeable; `0` → all list-only (today's behavior). Itinerary always still renders (Guardrail #3).

## Evidence model (Guardrail #1 compliance)

A hotel pin's evidence is the **Travala listing** (`travala_result_json`) + the **geocoded street address** — consistent with the PRD evidence source *"Travala hotel search result where applicable."* It is NOT a reel caption quote (hotels don't come from reels). The honest-failure path is what keeps us inside Guardrail #1: an unlocatable hotel is never pinned.

## Data flow (backend hotel stage)

```
runner.run_generation
  persist_itinerary  ──►  places rows WITH lat/lng   (runner.py:382, BEFORE the gather)
        │
        ▼  asyncio.gather (runner.py:490, best-effort, concurrent)
  _stage_hotels ──► persist_hotels (persist.py:801)
        │
        ├─ search_hotels()  ──►  hotels[] + address   (T1: parse content[1])
        │
        ├─ _trip_place_coords(trip_id) ──► [(place_id, lat, lng)]   (destinations)
        │
        ├─ rank_hotels(hotels, places, city, country):
        │     ├─ geocode each (gather, types=address, country=<trip>)  ─┐
        │     │      hit + country-match + ≤60km ? placed : UNRESOLVED  │ honest gate
        │     ├─ trim so placeable+places ≤ 25  (Matrix cap)            │
        │     ├─ fetch_matrix(sources=hotels, dests=places)  ── None ─► route_score=NULL (still placed)
        │     └─ blend(pref × centrality) ─► rank 1..3, is_recommended, place_durations
        │
        └─ DELETE by trip_id  +  INSERT rows (lat,lng,geo_status,route_score,rank,is_recommended,place_durations)
                 ▲ delete-first idempotency (persist.py:815) — NOT lease-fenced (R1)

frontend: getTrip select('*') ─► bundle.hotels ─► TripWorkspace {selectedHotelId, layerMode}
          ├─ HotelPanel: 3 cards, recommended badge, "couldn't place" note if unresolved
          └─ TripMap: layerMode==='route' ? drawTrail : drawSpokes(selected hub → each place)
```

## Non-goals (v1)

- Persisting the user's hotel selection (ephemeral only).
- Routed-polyline spokes (straight lines only).
- Per-day hub (one hub per trip).
- mem0 taste-driven hotel preference blend (star/price proxy for v1).
- `places`-row / `base_place_id` linking; hotel→place `transport_legs`.
- Geocode result caching (low volume; write-through cache deferred).
- Any booking / payments (banned by stack freeze).

---

## Tasks (task-by-task; each independently implementable + reviewable)

### Backend

**T1 — Parse Travala's second content block for the street address.**
- File: `backend/genagents/hotel.py` (parse currently at `:64-71`).
- Change: after building hotels from `content[0]`, also parse `content[1]`'s JSON and **merge `address`** (and optionally the narrative `location`/`headline` for display) onto each hotel dict, matched by `hotelId` (confirmed same order across blocks). Fully defensive: missing/malformed `content[1]` → hotels return unchanged (no address, no raise).
- Tests: two-content-block fixture → `address` merged by hotelId; single-block fixture → no crash, no address; mismatched/missing hotelId → skipped safely.
- Acceptance: `search_hotels()` return dicts carry `address` when Travala provides it; behavior unchanged when it doesn't.

**T2 — Mapbox Matrix client.**
- New file: `backend/genagents/matrix.py` (mirror `transport.py` style: injectable `client`, sanitized errors).
- `fetch_matrix(sources, destinations, *, profile="walking", annotations="duration,distance", token=None, client=None) -> Matrix | None`. Builds one coordinate list = sources + destinations, passes `sources`/`destinations` index arrays, parses `durations`/`distances` matrices. Returns `None` on non-2xx/network error (honest degrade). Enforce/assert `len(sources)+len(destinations) <= 25`.
- Profile default `walking` to match `fetch_directions_legs(profile="walking")` (`transport.py:141`); note it's a constant, easily changed.
- Tests: fake httpx → parsed matrix (durations+distances); error → `None`; over-cap input → guarded.

**T3 — Hotel geocode + rank orchestration (pure, testable).**
- New file: `backend/genagents/hotel_ranking.py`. Define a typed `RankedHotel` contract (dataclass/TypedDict) = the raw hotel dict + `lat, lng, geo_status, route_score, rank, is_recommended, place_durations`.
- **[CODEX-FOLD C4 — define the preference proxy; it was undefined]** `rank_hotels` must receive **`budget_level`** (from `trips.budget_level` / `req.budget_level`) — without it "price fit" is undefined. `tradeoffs.py` (`:37`, `:62` `build_hotel_comparisons`) already handles price basis (per-night vs total), currency normalization, and deterministic ties. **Extract the pure price-basis/currency-normalization helpers from `tradeoffs.py` and share them** (DRY) — don't duplicate or call `build_hotel_comparisons` wholesale. The preference proxy = normalized **relative affordability** (price basis vs `budget_level`) + normalized **stars**. **Reconcile the two recommendation signals:** `runner.py:497` derives a separate *cheaper-hotel* recommendation via `build_hotel_comparisons` after persistence — that is a **price/rating tradeoff panel**, a DISTINCT axis from our **route-central `is_recommended`** (the default-selected hub). Keep them orthogonal and labelled as such in the UI; do not let one silently override the other.
- `rank_hotels(hotels, places, city, country_code, budget_level, *, geocode, matrix) -> list[RankedHotel]`:
  1. Geocode each hotel **concurrently** (`asyncio.gather`, not a sequential loop — bounds added latency to ~1 geocode RTT, not N): `forward_geocode(f"{address}, {city}", types="address", country=<trip country_code>, proximity_lng_lat=<trip centroid>)`. **[FOLD-1] Pass the trip's `country_code` explicitly** — `forward_geocode` defaults `country="jp"` (`mapbox_forward.py`), so a non-Japan trip would silently never resolve. Derive `country_code` from the trip's `places` (`place.py:40`); centroid from `places` coords.
  2. **Concrete proximity/confidence gate** (`geo_status='placed'` vs `'unresolved'`). `placed` requires ALL of: geocode hit (non-None), returned `country_code` == trip country, and geocoded point within a **centroid-distance threshold (default 60 km, a const)** via haversine (reuse the `_nearest_place_id` haversine at `persist.py:607`). Any miss → `unresolved`, NULL coords, excluded from Matrix. **[FOLD-2] this gate is what makes honest-failure implementable — without a concrete rule it's unfalsifiable.**
  3. If `placeable + len(places) > 25`, trim lowest **preference-proxy** hotels (star desc, then price fit) until it fits.
  4. One `fetch_matrix(sources=placeable hotels, destinations=places, annotations=duration,distance)`. Centrality = **min average duration** to all places. Matrix `None` → `route_score=None`, all placeable still `placed`. **[CODEX-FOLD C5]** Destinations are only the real trip places — **exclude undayed/base-hotel `trip_places`** (don't route a hotel to itself). **Preserve destination ordering** when mapping Matrix columns back to places: the column index → `place_id` mapping must match the exact order destinations were submitted, or durations attach to the wrong place.
  5. Blend normalized preference-proxy + normalized centrality (default 0.5/0.5 const) → sort → `rank` 1..N; top **3**; `is_recommended` on rank 1. **[CODEX-FOLD C5]** `place_durations` = `{TripPlace.place_id: duration_s}` (keyed explicitly by `place_id` — the id the frontend has), built from the ordering-preserved column map. **[FOLD-3] Deterministic tie-break** (e.g. `(score desc, star desc, hotelId asc)`) — no `Math.random`/set-ordering — so ranking is reproducible (eval-safety).
- Pure (all IO injected) → fully unit-testable.
- Tests: geocode hit-in-proximity → placed; miss / out-of-radius / **country-mismatch** → unresolved; Matrix failure → placed but route_score NULL; cap-trim path; **tie-break determinism** (equal blended scores → stable order across runs); deterministic top-3 + recommended given fake geocode/matrix.

**T4 — Schema migration (`hotel_suggestions` new columns).**
- New file: `supabase/migrations/<ts>_hotel_geo_ranking.sql` (timestamp per repo convention, ~`20260804…`).
- `ALTER TABLE public.hotel_suggestions ADD COLUMN`: `lat double precision`, `lng double precision` (bounds check −90..90 / −180..180), `geo_status text NOT NULL DEFAULT 'unresolved' CHECK (geo_status IN ('placed','unresolved'))`, `route_score numeric`, `rank smallint`, `is_recommended boolean NOT NULL DEFAULT false`, `place_durations jsonb NOT NULL DEFAULT '{}'`. All nullable except the defaulted ones. RLS already governs the table (inherit; no policy change).
- **[F3/B — lease-fenced write; CODEX-FOLD C1]** Add a fenced RPC `replace_hotel_suggestions(p_job_id uuid, p_trip_id uuid, p_lease_token uuid, p_rows jsonb) returns boolean` that copies the EXACT contract of `replace_trip_itinerary` (`supabase/migrations/20260720150000_fenced_trip_itinerary_replace.sql`) — **not** a simplified token-equality check. Specifically it must:
  1. **Fence first, with a row lock:** `SELECT ... FROM jobs WHERE id = p_job_id AND trip_id = p_trip_id AND lease_token = p_lease_token AND status = 'running' FOR UPDATE`. The `FOR UPDATE` is what makes it race-safe; the `trip_id` binding and `status = 'running'` predicates are load-bearing (a lease on a different trip, or a job no longer running, matches zero rows).
  2. **Zero rows matched → abort** (return `false`, delete nothing) — a superseded/zombie worker never clobbers the live worker's rows.
  3. Matched → `DELETE hotel_suggestions WHERE trip_id = p_trip_id` then insert `p_rows`; return `true`.
  `p_lease_token` is `uuid` (not text — `jobs.lease_token` is uuid). `SECURITY DEFINER`, RLS/owner semantics unchanged, consistent with the itinerary RPC.
  **Caller (persist_hotels) must handle the boolean `false` / `LeaseLost` the same way `persist_itinerary` does** (treat a lost lease as "not my run anymore" — swallow, don't crash the stage).
- Acceptance: migration applies cleanly on a fresh + existing DB; existing rows get safe defaults; the RPC no-ops when `p_lease_token` doesn't match the job's current lease.

**T5 — Wire ranking into `persist_hotels`.**
- File: `backend/pipeline/persist.py` `persist_hotels()` (`:801-865`).
- Change: add `lat,lng` to the `trip_places → places` select (`:826-831`) to get destination coords (or accept `canonical` from the `runner.py:469` call site — pick the smaller diff; querying keeps it self-contained). **[FOLD-4 / DRY]** `persist_transport` already does this exact `trip_places → places(id,lat,lng)` select (`:550-558`); extract a shared `_trip_place_coords(client, trip_id)` helper and use it in both, rather than duplicating the query. After `fetch` (T1 hotels), call `rank_hotels(...)`. Build the row list with the 7 new fields.
- **[F3/B — lease-fenced write]** Thread `job_id` + `lease_token` from `run_generation` through `_stage_hotels` (`runner.py:465-475`) into `persist_hotels`, and route the delete+insert through the new `replace_hotel_suggestions` RPC (T4) instead of the raw `delete().eq(...)` + insert (`:815`, `:849`). This makes the hotel write reject a superseded/zombie worker, same guarantee `persist_itinerary` already has. When `job_id`/`lease_token` are absent (e.g. a non-job invocation path), fall back to the current raw delete+insert so tests and ad-hoc calls still work.
- **Best-effort:** wrap geocode/Matrix in a targeted try/except (not a bare `except`) so any failure → hotels written with `geo_status='unresolved'` (never raise out of `_stage_hotels`; Guardrail #3). Note: the lease fence and best-effort degradation are orthogonal — a geocode failure still writes (unresolved rows) through the fenced RPC; only a lost lease suppresses the write.
- Pass `budget_level` (from the trip row already selected at `persist.py:817-819`) into `rank_hotels` (C4).
- Field-name parity: the insert dict at `persist.py:849` MUST write **all 7** new keys explicitly, matching the migration columns and the TS type (T6) exactly.
- **[CODEX-FOLD C3 — deploy gate]** `hotel_suggestions` is now a **writer-used** table with new columns, so the pre-deploy schema gate `backend/scripts/assert_schema.py` (manifest ~`:95`; contract at `:54` requires writer-used columns be listed) MUST add all 7 new columns to its `hotel_suggestions` tuple **in this same PR** — otherwise the gate is stale (the failure mode that bit the entitlements arc). Update `test_assert_schema.py` accordingly.
- Tests: fakes for `search_hotels`/`geocode`/`matrix` → asserts written rows carry coords/rank/geo_status; all-fail → all `unresolved`; re-run idempotent; **lease fence: a stale `lease_token` → RPC no-ops (no delete, existing rows survive); matching token → replaces** (mirror the `persist_itinerary` fenced-write tests).

### Frontend (ship in the same PR as T4 — Guardrail #4)

**T6 — `HotelSuggestion` type + fixtures.**
- File: `frontend/lib/trip/backend-types.ts` (`:134-149`). Add, with **nullability matching the migration exactly [CODEX-FOLD C3]**: `lat: number | null`, `lng: number | null`, `route_score: number | null`, `rank: number | null` (these four are the only nullable ones), and the NON-NULL (defaulted) columns `geo_status: 'placed' | 'unresolved'`, `is_recommended: boolean`, `place_durations: Record<string, number>` (NOT `| null` — the column is `NOT NULL DEFAULT '{}'`).
- Update fixture `frontend/lib/trip/fixtures/tokyo-trip.ts:174` (both `hotel_1` and `hotel_2`) + any mock-api with the new fields (keep `backend-types.test.ts` green). Give the non-null fields concrete values (`geo_status:'placed'`, `place_durations:{}`, `is_recommended`), not null.

**T7 — Pure selector helpers.**
- File: `frontend/lib/trip/selectors.ts`. Add: `recommendedHotelId(bundle)` (rank 1 / is_recommended among `placed` hotels; **`null` when none placed** — C5), `selectedHotel(bundle, id)`, `hubSpokeFeatures(hotel, bundle)` → GeoJSON `FeatureCollection` of straight 2-point `LineString`s from the hotel to each destination place. **[CODEX-FOLD C5]** Destinations exclude undayed/base-hotel places (don't spoke to a hotel); each spoke carries its `place_durations[place_id]` as a label property, but a **missing/non-finite duration still draws an unlabeled spoke** (never drop the line). Returns an empty collection for an unresolved/absent hotel.
- Tests: unit-test each (recommended pick + null-when-none-placed, spoke geometry, base-hotel excluded from destinations, missing-duration → unlabeled-but-present spoke, unresolved/absent hotel → empty collection).

**T8 — Shared state + `HotelPanel` selection + toggle.**
- `TripWorkspace.tsx`: add `useState` `selectedHotelId` (default `recommendedHotelId(bundle)`, which is **`null` when no hotel is `placed`** — C5) and `layerMode: 'route' | 'hub'` (default `'route'`). Pass both to `<TripMap>` (`:155`) and `<HotelPanel>` (`:257`). Add the **toggle control** (segmented Route / Hotel) near the map. **[CODEX-FOLD C5]** When **no hotel is placeable**, disable the Hotel toggle (or, if toggled, show an explicit map empty-state — never a silently blank map).
- `HotelPanel.tsx`: add props `selectedHotelId`, `onSelectHotel`; show a **recommended badge** (rank 1) and, for `geo_status==='unresolved'`, the honest *"couldn't place this hotel on the map"* note. **[CODEX-FOLD C5] Unresolved hotels are NOT selectable as a hub** — either disable the click for unresolved rows, or if selected, hub mode shows the explicit empty-state, never a blank map with no pin. Only `placed` hotels wire `onClick` (`:23`) → `onSelectHotel(h.id)`.
- Tests (RTL): click a placed hotel selects it; toggle flips `layerMode`; unresolved hotel shows the note AND is non-selectable; all-unresolved → toggle disabled / empty-state; recommended badge renders.

**T9 — `TripMap` hub pin + spokes + trail gating.**
- `TripMap.tsx`: accept `selectedHotelId`, `layerMode`. **[CODEX-FOLD C2 — coexist, don't break existing pins]** `drawMarkers()` (`:55`) keeps rendering `bundle.places` (incl. the existing receding base-hotel behavior the `TripMap.test.tsx:217` test asserts) in **route mode, unchanged**. In **hub mode**: add the distinct `hotel-hub-pin` marker at the selected `placed` hotel coord, AND **suppress any `bundle.places` marker that is a hotel base** (`place_type='hotel'` / referenced by a hotel's `base_place_id`) so there's no duplicate pin. Gate `drawTrail()` (`:89`) to `layerMode==='route'`; when `'hub'`, call a new `drawSpokes()` using `hubSpokeFeatures(...)` (T7), pushing layer ids into `routeIdsRef` for `clearRoutes()` teardown (`:24`). Add a redraw effect keyed on `selectedHotelId` + `layerMode` (alongside `:172/:195/:205`). Add `hotel-hub-pin` CSS. Honest empty-state: `hub` + no `placed`/`null` selected hotel → draw no hub + no spokes (panel/empty-state handles messaging).
- Tests: BOTH modes — route mode still renders the receding base-hotel pin (existing test stays green); hub mode renders one hub + spokes and suppresses the duplicate base place marker. Canvas-heavy visuals → rely on T7 pure tests + `/qa` live-verify.

### Close-out (per BUILD-LOOP)
- Final `astrail-reviewer` (opus) whole-branch pass **AND** gstack `/review` (Codex cross-model) — run both.
- `/qa` live-verify: generate a trip → hotels get coords; toggle switches layers; picking a hotel re-pins + redraws spokes; an unresolvable hotel shows the honest note and no pin.
- PR (three sides — migration + persist + types — in one PR), merge/sync, update `.claude/docs` + EMDEE + memory.

---

## Risks / flags for review

- **R1 — RESOLVED (F3 → B).** `persist_hotels` will be lease-fenced via the new `replace_hotel_suggestions` RPC (T4/T5), giving the hotel write the same zombie-worker protection `persist_itinerary` has. No longer an open risk.
- **R2 — Matrix 25-coord cap.** Handled by cap-trim in T3; confirm the trim keeps ≥ the eventual top-3.
- **R3 — Geocode ambiguity.** Mitigated by structured `types="address"` + proximity gate + honest `unresolved`. Never invents coords.
- **R4 — RESOLVED (Codex C2).** Rendering from `bundle.hotels` is confirmed right for the 3 ephemeral candidates, but must **coexist** with the existing base-hotel place-pin path (live in `TripMap.test.tsx:217`): route mode unchanged, hub mode adds one hub + suppresses the duplicate base place marker. Folded into decision #1 + T9.
- **R5 — Preference proxy, not mem0** (decision #6). Confirm acceptable v1 scope; deferral trigger recorded.
- **R6 — Cost/latency** added to every generation (best-effort, concurrent with other stages). Acceptable; geocode caching deferred.
- **R7 — `MAPBOX_SECRET_TOKEN` in pipeline env.** If absent, geocode + Matrix degrade → all hotels `unresolved` (consistent with `capture.py:220`). Confirm the token is present on Render for the pipeline, else the feature silently no-ops (honestly).
- **R8 — Schema parity is 3 non-Pydantic sides:** migration columns ↔ `persist.py` insert dict keys ↔ `backend-types.ts` fields. No Pydantic bundle model exists; the `RankedHotel` contract (T3) is the closest backend "model." Names must match exactly.

## GSTACK REVIEW REPORT

**Eng-review (Claude, plan-stage) — DONE. Codex outside voice — PENDING (job running; report updates on return).**

### Step 0 — Scope challenge
- **What already exists (reused, not rebuilt):** forward geocoder (`mapbox_forward.py`), pin rendering (`TripMap.drawMarkers`), hotel search + persist (`hotel.py` + `persist_hotels`), client read path (`getTrip` `select('*')` — no new endpoint). Directions (`transport.py`) deliberately NOT reused for ranking — Matrix is the correct many-to-many primitive.
- **Complexity check TRIGGERED** (2 new modules: `matrix.py`, `hotel_ranking.py`). Verdict: **justified, not over-engineered** — `matrix.py` is a thin external-API client (mirrors `transport.py`, testable with fakes); `hotel_ranking.py` isolates pure orchestration from the IO-heavy `persist_hotels` (testability + explicit-over-clever). Surfaced to user as D-decision.

### Findings (confidence-scored)
| # | Sev | Conf | Finding | Disposition |
|---|-----|------|---------|-------------|
| F1 | P1 | 8/10 | `forward_geocode` defaults `country="jp"`; non-Japan trips silently never resolve | **FOLDED** into T3 (pass trip `country_code`) |
| F2 | P1 | 8/10 | "out-of-proximity" was undefined → honest-failure unimplementable | **FOLDED** into T3 (country-match + ≤60km haversine gate) |
| F3 | P2 | 7/10 | R1: unfenced delete-first + added geocode/Matrix latency → superseded-worker clobber window | **FOLDED (user chose B)** — lease-fenced `replace_hotel_suggestions` RPC (T4/T5) |
| F4 | P2 | 7/10 | Geocoding shortlist sequentially adds N×latency | **FOLDED** into T3 (`asyncio.gather`) |
| F5 | P2 | 7/10 | Ranking must be deterministic (eval-safety) | **FOLDED** into T3 (stable tie-break + test) |
| F6 | P3 | 6/10 | DRY: `trip_places→places` coord select duplicated with `persist_transport` | **FOLDED** into T5 (`_trip_place_coords` helper) |
| F7 | P3 | 6/10 | Geocode caching (write-through, Guardrail #7) not done | **TODO** (low volume; deferred) |

### Coverage (plan-level)
Backend paths (hotel.py parse, matrix client, rank orchestration incl. all honest-failure branches, persist integration) all have planned unit tests. Frontend: pure selectors unit-tested; HotelPanel RTL (click/toggle/unresolved-note); TripMap canvas → rely on selectors + `/qa`. Gaps closed by folds: country-mismatch test, determinism test, unresolved-hub empty-state test. **`/qa` live-verify required** (Mapbox + full-flow change).

### Failure modes (each has handling + is non-silent)
geocode miss / country-mismatch / >60km → `unresolved` + panel note · Matrix fail → `placed`, no route_score · MAPBOX token missing → all `unresolved` · content[1] malformed → no address → `unresolved` · all unresolved → list-only, itinerary still renders (Guardrail #3). No silent-failure critical gaps.

### NOT in scope (deferred, with trigger)
Ephemeral→persisted selection (trigger: booking/day-routing) · straight→routed spokes (trigger: users want real paths) · star/price→mem0 preference (trigger: taste-based hotel ranking) · `base_place_id`/`places`-row linking (trigger: routed hotel legs) · geocode cache (trigger: volume) · per-day hub (trigger: multi-day route model).

**Decisions resolved:** F3 → **B** (lease-fenced hotel write). Module structure → **A** (keep `matrix.py` + `hotel_ranking.py`).

### Codex outside voice (cross-model) — ran in 2 passes; initial verdict **BLOCK**, all findings folded
| # | Finding | Fold |
|---|---------|------|
| C1 | Lease RPC spec was a naive token check; real `replace_trip_itinerary` contract needs `(job_id,trip_id,lease_token)`, `returns boolean`, `FOR UPDATE` row lock, `status='running'` predicate, abort-on-zero-match | **FOLDED** T4 |
| C2 | Architecture conflict: base hotel already modeled as a place with a receding pin (`TripMap.test.tsx:217`) — "render from bundle.hotels" must coexist, not break it | **FOLDED** decision #1 + T9 (route unchanged / hub suppresses dup) |
| C3 | Schema-parity: nullability mismatch (`place_durations`/`geo_status`/`is_recommended` are NOT NULL) **and** the `assert_schema.py` deploy gate must add all 7 writer-used columns (same class that bit the entitlements arc) | **FOLDED** T6 + T5 |
| C4 | Preference proxy undefined — `rank_hotels` got no `budget_level`; `tradeoffs.py` already owns price/currency logic; two recommendation signals need reconciling | **FOLDED** T3 + T5 |
| C5 | Honest-failure holes: unresolved hotel must be non-selectable/empty-state (not blank map); all-unresolved → `null` + disabled toggle; `place_durations` keyed by `place_id`; preserve Matrix destination order; exclude base hotel from spokes; unlabeled spoke when duration missing | **FOLDED** T3/T7/T8/T9 |

**CROSS-MODEL:** No tension — Codex's findings were gaps the Claude pass missed, not disagreements. Both models agree on the shape; Codex hardened the contracts (lease fence, schema gate, price-fit) and the honest-failure edges. This is the "run both" payoff the build loop mandates.

**VERDICT:** ENG (Claude) + CODEX (cross-model) **PLAN-CLEARED** — 6 eng folds (F1–F6) + 5 Codex folds (C1–C5) + 1 deferred TODO (F7); Codex's initial BLOCK is resolved by the folds above. No open decisions. Ready for the implement phase (subagent-driven-development).

NO UNRESOLVED DECISIONS
