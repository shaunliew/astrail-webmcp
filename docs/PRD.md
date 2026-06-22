# Astrail V1 Beta PRD

## 1. Summary

**Product:** Astrail

**Pitch:** Astrail turns scattered travel inspiration into the route you actually take.

**V1 Goal:** Let beta users generate, save, and revisit a useful Japan-first trip itinerary from Instagram Reels, user-requested places, dates, budget, origin, preferences, and remembered travel taste.

Astrail v1 is a **map-first AI trip planning web app**. The user signs in with Google, collects inspiration in an Inspiration Tray, confirms a Trip Brief, and receives a progressively generated trip with mapped stops, evidence, day-by-day itinerary, weather, route-aware restaurants, Mapbox route legs, and an orchestrator summary.

The MVP is **not** a booking product, social sharing product, transit planner, Instagram account integration, or itinerary editor. It is a trust-first beta that proves users can turn messy travel inspiration into a saved route they would realistically use.

## 2. Target Beta

**Primary beta user:** Travelers planning Japan trips from Instagram Reels.

**Initial beta size:** 50-100 users.

**Access model:** Open Google OAuth through Supabase Auth, protected by strict quota and cost controls.

**Primary device support:** Responsive mobile and desktop. Desktop can be richer; mobile must be usable for real trip planning.

**V1 destination focus:** Japan-first, with Tokyo as the primary demo/eval market.

## 3. Brand And UX Direction

Astrail = Astra + Trail: a star path, guided route.

The product should make users feel that scattered inspiration is becoming a navigable path. The visual language may use stars, trails, constellations, luminous route lines, and dark-sky map atmosphere, but it must remain a trustworthy travel planning product.

The key UX metaphor:

```text
scattered inspiration -> verified places -> connected route -> saved trail
```

Use this metaphor in interaction, not just decoration:

- Reels and requested places are "inspiration points".
- Verified places become mapped stops.
- Route lines connect stops into a trail.
- The final itinerary is the guided route the user can follow.

Avoid cartoon space theming, excessive decorative galaxies, fake planets, and visual effects that reduce map readability.

## 4. Success Criteria

Astrail v1 is successful if:

- A beta user can generate a useful saved trip from Reels, requested places, or both.
- Users can add inspiration through manual paste, clipboard paste, and PWA share target where supported.
- Users can generate even if they provide no free-text preferences.
- Returning users can generate with remembered preference context when current preferences are blank or incomplete.
- Mapped places appear within **60s p75**.
- First itinerary content appears within **120s p75**.
- Full saved trip appears within **180s p75**, excluding optional late summary updates.
- Every shown place has valid coordinates and evidence.
- Every itinerary day shows connected route legs where Mapbox routing succeeds.
- 80% of curated Japan eval sets produce a usable saved trip.
- Users can revisit generated trips from their trip list.
- Users can give feedback tied to the generated trip and specific artifacts.

## 5. Non-Goals

V1 does not include:

- Hotels.
- Payments.
- Flights.
- Booking.
- Public sharing.
- Collaborative planning.
- Itinerary editing/refinement chat.
- Full public-transit train/subway planning.
- Instagram account connection.
- Importing saved Instagram collections.
- Custom admin dashboard.
- Google Maps or Google Places.
- Manual audio transcription, `yt-dlp`, `ffmpeg`, or self-hosted Whisper.
- Apify MCP or Agents SDK in the scrape loop.
- Three.js.

## 6. Core User Flow

1. User visits app and signs in with Google.
2. User opens `/app`.
3. User adds travel inspiration into the Inspiration Tray:
   - 1-5 Instagram Reel URLs.
   - user-requested places.
   - optional destination hint.
   - optional trip dates.
   - optional budget level.
   - optional origin city.
   - optional free-text preferences.
4. User confirms the Trip Brief before generation.
5. If preferences are blank, Astrail shows whether it will use memory or inferred defaults.
6. Backend creates a trip row and durable job immediately.
7. UI streams generation progress.
8. Places appear on the map as soon as they are verified.
9. Route legs draw between connected stops as Mapbox routing completes.
10. Full itinerary fills in progressively.
11. Trip is saved automatically.
12. User can revisit it from `/app/trips`.
13. User can leave feedback on the trip or specific outputs.

## 7. Inspiration Input

Astrail v1 must support a streamlined way to collect travel inspiration before generation.

The core input surface is an **Inspiration Tray**.

The tray accepts:

- Instagram Reel URLs.
- User-requested places.
- Optional destination hint.
- Optional dates.
- Optional budget.
- Optional origin city.
- Optional preferences.

Users can add Reel URLs through:

1. **Manual paste**
   - Required fallback.
   - Supports pasting one URL, multiple URLs, or messy text containing URLs.

2. **Paste from clipboard**
   - User taps a paste button.
   - Astrail parses Instagram Reel URLs from clipboard text.
   - If clipboard has no valid Reel URL, show a clear inline warning.

3. **PWA share target**
   - Progressive enhancement.
   - If Astrail is installed as a PWA and browser/platform supports Web Share Target, users can share a Reel link into Astrail.
   - This must not be required for successful trip creation.

The tray must:

- Parse valid Instagram Reel URLs from messy text.
- Normalize URLs.
- Deduplicate duplicate links.
- Enforce max 5 Reel URLs per trip.
- Let users remove/edit items before generation.
- Show invalid links clearly.
- Keep requested places separate from Reel links.

Input item model:

```ts
type InspirationItem =
  | {
      type: "reel_url";
      url: string;
      normalizedUrl: string;
      source: "manual_paste" | "clipboard" | "web_share_target";
      status: "valid" | "invalid" | "duplicate";
    }
  | {
      type: "requested_place";
      text: string;
      source: "manual_input";
      status: "pending_resolution" | "resolved" | "ambiguous" | "unresolved";
    };
```

V1 must not promise Instagram saved-collection import or Instagram account sync.

## 8. Trip Brief Requirements

The Trip Brief is the user's pre-generation confirmation screen.

It must show:

- Submitted Reel URLs.
- User-requested places.
- Destination hint, if provided.
- Inferred destination, if available.
- Dates and duration.
- Budget level or default budget assumption.
- Origin city, if provided.
- Preference source.
- Preference summary.
- Max trip scope warning if places exceed the limit.

Preference source must be one of:

```ts
type PreferenceSource =
  | "explicit"
  | "memory"
  | "inferred_default";
```

Example with explicit preferences:

```text
Destination hint: Tokyo, Japan
Dates: 2026-06-10 to 2026-06-13
Reels: 4
Requested by you: Tokyo Disneyland
Preferences: ramen, walkable days, not too rushed
Preference source: explicit
```

Example with memory:

```text
Preferences not provided.
Using your saved travel preferences:
- prefers mid-range budget
- likes walkable days
- likes ramen and casual food
- avoids rushed itineraries
Preference source: memory
```

Example with no memory:

```text
Preferences not provided.
Astrail will infer your trip style from the Reels and build a balanced first draft.
Preference source: inferred default
```

## 9. Preference And Memory Behavior

Astrail must support preference-free generation.

Minimum generation input:

- At least one Reel URL, or
- At least one user-requested place.

Preferences are optional.

Preference priority:

1. **Explicit current input**
   - Current user-entered preferences always win.
   - Example: if memory says "budget" but current input says "luxury", use luxury.

2. **Saved preference memory**
   - Used when current preferences are blank or incomplete.
   - Memory may fill gaps such as pace, food taste, budget style, and transport tolerance.

3. **Inferred defaults**
   - Used when current preferences are blank and no relevant memory exists.

Default assumptions:

```ts
budgetLevel: "mid_range"
pace: "balanced"
foodPreference: "local/popular near route"
transportPreference: "walkable where practical"
activityPreference: "based on submitted Reels and requested places"
```

Astrail may infer trip style from submitted Reels:

- food-heavy Reels -> food-led itinerary.
- landmark/temple Reels -> sightseeing-led itinerary.
- theme park Reels or requested theme park -> anchor around full-day attraction.
- shopping/neighborhood Reels -> area-based itinerary.
- mixed Reels -> balanced itinerary.

All inferred assumptions must be disclosed in the Trip Brief and final trip overview.

## 10. Memory Requirements

V1 uses mem0 only for preference memory.

Astrail may remember:

- cuisine preferences.
- pace preferences.
- budget style.
- transport tolerance.
- neighborhood/activity preferences.
- recurring avoidances, such as "not too rushed".

Astrail must not silently use memory.

When memory is used, the UI must show:

```text
Using your saved travel preferences
```

After generation, show a memory receipt:

```text
Astrail learned:
- likes walkable routes
- prefers food-focused days
- budget style: mid-range
```

Settings must allow users to:

- view saved preference summary.
- clear preference memory.
- understand what Reel evidence is stored.
- understand when memory affects generation.

Memory must not store raw full trip history as user preference data. It stores distilled preference facts only.

## 11. Place Source Model

Astrail must support three source types:

```ts
type PlaceSourceType =
  | "reel_extracted"
  | "user_requested"
  | "agent_suggested";
```

### Reel-Extracted Places

A place extracted from submitted Reel content.

Required evidence:

- Reel URL.
- Verbatim caption/location/transcript quote.
- Valid lat/lng.
- Research or Mapbox source.

UI chip:

```text
Reel quote
```

### User-Requested Places

A place explicitly mentioned by the user but not necessarily present in Reels.

Example:

```text
"Also want to go Disneyland."
```

Required evidence:

- Verbatim user text quote.
- Resolved place name.
- Mapbox Search Box result.
- Valid lat/lng.
- Research source URL when available.

UI chip:

```text
Requested by you
```

If ambiguous, Astrail should ask for clarification before generation where possible. For example, "Disneyland" could mean Tokyo Disneyland, Hong Kong Disneyland, or Disneyland California.

### Agent-Suggested Places

A place suggested by Astrail, such as a restaurant near the route.

Required evidence:

- Agent rationale.
- Research URL or Mapbox context.
- Valid lat/lng.

UI chip:

```text
Suggested by Astrail
```

## 12. Anti-Hallucination Rule

No place appears in the trip unless it has one of:

- Reel evidence.
- User-request evidence.
- Trusted tool/research evidence.

Every visible place must have:

- `name`
- `sourceType`
- `lat`
- `lng`
- `evidence`
- `confidence`
- `sourceUrl` or trusted tool source metadata

If a candidate place cannot be resolved, Astrail drops it and records the drop in the generation timeline.

## 13. Map Experience Direction

Astrail's map is the core product surface.

The frontend should use Mapbox Standard as the primary trip canvas:

```text
mapbox://styles/mapbox/standard
```

The map should use:

- globe-to-city camera movement.
- pitched 3D city views.
- 3D buildings and landmarks where available.
- dusk/night lighting during inspiration and generation.
- readable trip exploration lighting after generation.
- custom route layers.
- custom place pins.
- selected-place highlights.
- day route filtering.

Mapbox Standard should support the Astrail metaphor:

```text
Reels/requested places start as inspiration points.
Verified places become mapped stops.
Routes connect stops into a guided trail.
```

The map must remain practical:

- readable labels.
- visible attribution.
- clear place selection.
- accessible controls.
- responsive mobile layout.
- evidence and itinerary panels must not hide the route.

## 14. Routing And Connected Locations

Astrail must show how itinerary stops connect.

For each generated day, backend computes route legs between ordered stops using Mapbox Directions API.

Each transport leg must include:

```ts
type TransportLeg = {
  id: string;
  dayNumber: number;
  fromPlaceId: string;
  toPlaceId: string;
  profile: "walking" | "driving" | "driving-traffic" | "cycling";
  distanceMeters: number | null;
  durationSeconds: number | null;
  geometry: GeoJSON.LineString | null;
  source: "mapbox_directions";
  status: "ok" | "no_route" | "failed";
  warning?: string;
};
```

V1 supported routing profiles:

- walking.
- driving.
- driving-traffic where useful.
- cycling where useful.

V1 does **not** provide full train/subway routing.

If a route leg is long in a Japan city, the UI may show:

```text
Long transfer. Public transit may be preferable; detailed train routing is not available in v1.
```

### Directions API Usage

Directions API is the primary source for displayed route geometry, duration, and distance.

Use it for:

- stop A -> stop B.
- stop B -> stop C.
- stop C -> stop D.

Prefer per-leg calls over one large daily route call because:

- one failed leg does not break the whole day.
- each leg can have its own profile.
- each leg can be cached independently.
- UI can show precise warnings.

### Optimization API Usage

Mapbox Optimization API v1 may be used as a helper for flexible same-day stop ordering.

It must not be treated as the final itinerary planner.

Optimization may help when:

- a day has several flexible stops.
- no stop has strict time constraints.
- no requested anchor must happen at a specific time.
- the goal is to reduce travel time.

Optimization must not override:

- user-requested anchors.
- full-day attractions.
- time-specific recommendations.
- explicit user preferences.
- narrator/orchestrator constraints.
- evidence quality.

Final itinerary order is decided by Astrail's planning pipeline, not Mapbox Optimization alone.

## 15. Generated Trip Content

A saved trip should show:

### Trip Overview

- Trip title.
- Destination.
- Dates and duration.
- Budget.
- Origin city.
- Preference source.
- Assumptions used.
- Trip status: `generating`, `complete`, `saved_with_gaps`, or `failed`.
- Orchestrator summary.
- Missing-data warnings, if any.
- Total mapped movement summary.

### Map

The map is the main canvas.

It should show:

- All verified places.
- Day-based route lines.
- Selected place focus.
- Day filtering.
- Bottom place rail or mobile sheet.
- Route leg visualization.

The legacy TripCanvas map is a strong base and should be ported, renamed, and cleaned up for Astrail.

### Day-By-Day Itinerary

Each day should show:

- Day number.
- Date.
- Short day title.
- Morning / afternoon / evening plan.
- Ordered stops.
- Weather note.
- Restaurant anchors.
- Transport legs.
- Total movement estimate.
- Practical planning note.

The itinerary should be scannable, not essay-like.

### Place Intel Panel

When a user selects a place, show:

- Name.
- Category.
- Source type.
- Why it was included.
- Evidence quote or user-request quote.
- Source Reel URL when applicable.
- Research URL.
- Address/area.
- Confidence.
- Related day.
- Nearby restaurant suggestions if relevant.
- Connected route legs.

### Restaurant Strip

For MVP, restaurant suggestions are route-aware, not a full food planner.

Show:

- 2-4 suggestions.
- Day/area association.
- Why it fits user preferences or inferred/default preferences.
- Whether it is near a route or stop.
- Source URL.
- Evidence/source chip.

### Transport Strip

Transport shows Mapbox route legs.

Show:

- From stop.
- To stop.
- Route profile.
- Estimated duration.
- Distance.
- Source chip: `Mapbox route`.
- Warnings for failed/long legs.

### Agent Decision Timeline

The timeline should show decisions, not raw logs.

Examples:

```text
Scraped 4 Reels.
Found 8 candidate places.
Dropped 2 places without coordinates.
Mapped 6 verified places.
Used transcript fallback for Reel 3.
Resolved Tokyo Disneyland from your request.
Using saved preference memory: walkable days, ramen, balanced pace.
No preferences provided; inferred balanced trip style from Reels.
Computed 9 of 10 route legs.
Could not route Shibuya Sky -> Tokyo Disneyland.
Weather unavailable beyond forecast window.
Saved trip with missing restaurant suggestions.
```

No hidden chain-of-thought is shown.

### Evidence Chips

Every major recommendation should carry visible evidence chips:

- `Reel quote`
- `Requested by you`
- `Research`
- `Mapbox route`
- `Open-Meteo`
- `Memory preference`
- `Inferred default`
- `Suggested by Astrail`

## 16. Progressive Generation And Latency

Astrail must optimize for **time to first mapped value**, not only final completion.

Target progression:

```text
Trip row created: <2s
Trip Brief shown: instant
Mapped places visible: <60s p75
First itinerary day visible: <120s p75
Full saved trip: <180s p75
Optional summary/late sections may finish after
```

Generation phases:

1. Create trip/job.
2. Scrape Reels.
3. Extract Reel places and resolve user-requested places.
4. Apply explicit preferences, memory, or inferred defaults.
5. Deduplicate and map verified places.
6. Enrich places, weather, restaurants, and transport in parallel.
7. Compute Mapbox route legs.
8. Narrate itinerary.
9. Summarize with read-only orchestrator.
10. Save final or partial trip.

Partial output must be persisted as soon as it is ready.

## 17. Partial Failure Behavior

Astrail should save partial trips instead of failing the whole run when non-critical stages fail.

Critical failures:

- No authenticated user.
- Invalid trip request.
- No valid Reel URLs and no requested places.
- No verified places after extraction/resolution.
- Trip owner mismatch.

Non-critical failures:

- Weather unavailable.
- Restaurant suggestions timeout.
- Transport leg timeout.
- Individual Mapbox route leg failure.
- Orchestrator summary timeout.
- Some Reels fail while others succeed.
- Memory lookup unavailable.

If memory fails, Astrail falls back to inferred defaults and records that in the timeline.

If a route leg fails, the trip still saves and the UI shows the missing leg.

Status:

```ts
type TripStatus =
  | "draft"
  | "generating"
  | "places_ready"
  | "complete"
  | "saved_with_gaps"
  | "failed";
```

## 18. Backend Requirements

Backend stack:

- FastAPI.
- Python >=3.14.
- OpenAI Agents SDK.
- Supabase service-role client server-side only.
- Supabase Auth JWT validation.
- Supabase Postgres, RLS, Realtime, Storage, pgvector.
- Render Singapore deployment.
- Langfuse, Sentry, PostHog.
- mem0 for preference memory.
- Mapbox Search Box, Directions, and optional Optimization.

Required endpoints:

```text
GET    /health
POST   /generate-trip
GET    /generate-trip/stream/:tripId
GET    /trips
GET    /trips/:tripId
DELETE /trips/:tripId
POST   /trips/:tripId/feedback
POST   /settings/memory/clear
GET    /settings/preferences
```

All endpoints except `/health` require Supabase JWT auth.

## 19. Pipeline Requirements

### Phase 1: Scrape

- Normalize Reel URLs.
- Scrape via direct Apify HTTP.
- No MCP.
- No LLM scraping loop.
- Use transcript fallback only when caption/location are weak.
- Cache by normalized Reel URL.

### Phase 2: Extract And Resolve

Run in parallel:

- Place extraction from Reel content.
- User-requested place resolution.
- Destination hint resolution.

Extractor requirements:

- Use OpenAI Agents SDK.
- Use structured Pydantic output.
- Require web search for coordinates/research.
- Validate evidence quote as verbatim substring for Reel places.
- Drop candidates without lat/lng.

Requested place requirements:

- Resolve with destination context.
- Use Mapbox Search Box.
- Verify with research where needed.
- Ask clarification before generation when ambiguity is obvious.

### Phase 3: Preference Context

Build the preference context from:

1. explicit user input.
2. saved memory.
3. inferred defaults.

The final preference context must be persisted with the trip so the output is auditable.

### Phase 4: Enrich

Run in parallel:

- Place enrichment.
- Weather via Open-Meteo.
- Route-aware restaurant suggestions.
- Mapbox route-leg computation.

Weather, restaurant, transport, and memory failures must not kill the trip.

### Phase 5: Narrate And Summarize

- Narrator creates day-by-day itinerary.
- Orchestrator summary is read-only.
- Orchestrator may summarize gaps and tradeoffs but must not override the itinerary.

## 20. OpenAI Agents SDK Requirements

Use current Agents SDK patterns:

- `Agent` for specialist agents.
- `Runner.run` for structured phase outputs.
- `Runner.run_streamed` only where agent stream events materially improve progress UX.
- Pydantic `output_type` for every agent.
- `ModelSettings(tool_choice="required", parallel_tool_calls=True)` where live tool use is mandatory.
- Blocking guardrails before untrusted Reel content can drive tool calls.
- Function-tool timeouts for external APIs.
- Code-side validation after model outputs.

Reference docs:

- [Agents](https://openai.github.io/openai-agents-python/agents/)
- [Tools](https://openai.github.io/openai-agents-python/tools/)
- [Guardrails](https://openai.github.io/openai-agents-python/guardrails/)
- [Streaming](https://openai.github.io/openai-agents-python/streaming/)
- [Results](https://openai.github.io/openai-agents-python/results/)

## 21. Supabase Data Requirements

Minimum tables:

- `users`
- `trips`
- `jobs`
- `generation_events`
- `reel_cache`
- `places`
- `trip_places`
- `trip_days`
- `transport_legs`
- `restaurant_suggestions`
- `feedback`
- `user_preferences`
- `memory_events`

RLS requirements:

- Users can only read/write their own trips.
- Users can only read/write feedback attached to their own trips.
- Users can only read/write their own preference summary.
- Service role writes global caches.
- Client never receives service-role key.

Caching requirements:

- Reel cache.
- Place cache.
- Research/enrichment cache where practical.
- Route cache by `fromPlaceId + toPlaceId + profile`.
- Weather cache.
- Restaurant cache by area and preference hash.

Mapbox storage caveat:

- Before using Mapbox-derived coordinates/results in a global permanent place cache, confirm Mapbox storage rights or use the appropriate Mapbox permanent geocoding/storage terms.
- For v1, persist the minimum trip output needed for the user's saved trip and preserve attribution/source metadata.

## 22. Quotas And Abuse Control

For open Google OAuth beta:

- Max 5 Reel URLs per trip.
- Max 3 generated trips per user per day.
- Max 8 total itinerary places after dedup/requested-place merge.
- OpenAI budget alerts enabled.
- Auto-recharge off.
- slowapi request limiting on backend.
- Per-user quota enforced in Postgres.

## 23. Frontend Requirements

Frontend stack:

- Next.js 15 App Router.
- React 19.
- Tailwind v4.
- Mapbox GL JS 3.x.
- Supabase browser client.
- PostHog.

Required routes:

```text
/sign-in
/app
/app/trips
/app/trip/[tripId]
/app/settings
/share-target
```

Frontend responsibilities:

- Zhi Hao owns frontend UX and integration.
- Port legacy Mapbox interaction model.
- Use Mapbox Standard for the main trip canvas.
- Build responsive mobile and desktop layouts.
- Implement Inspiration Tray.
- Implement clipboard paste.
- Implement PWA share target as progressive enhancement.
- Implement SSE parser.
- Render progressive trip state.
- Render partial failure states.
- Render route legs and long-leg warnings.
- Render evidence chips everywhere.
- Render preference source and assumptions.
- Render memory receipt.
- Submit feedback.
- Show memory/privacy settings.

## 24. Observability And Feedback

Required external tooling:

- Langfuse for agent traces and evals.
- Sentry for backend/frontend errors.
- PostHog for product analytics.
- UptimeRobot for `/health`.
- Supabase dashboard for data/debugging.
- Render/Vercel dashboards for deploy health.

In-app feedback:

- Overall trip feedback.
- Artifact feedback for places/routes/restaurants.
- Optional free-text note.
- Store feedback with `tripId`, artifact ID, source type, generation stage, preference source, and timestamp.

## 25. Evaluation Dataset

Before beta launch, create 10-20 Japan Reel eval sets.

Each eval set should include:

- Reel URLs.
- Destination hint.
- Expected extracted places.
- Accepted aliases.
- Required evidence quotes where known.
- Known ambiguous places.
- Expected user-requested places if present.
- Preference mode:
  - explicit.
  - memory.
  - inferred default.
- Expected route sanity notes.
- Human quality notes.

Eval gates:

- No hallucinated visible places.
- User-requested places resolve correctly or ask clarification.
- Preference-free generation produces a reasonable balanced draft.
- Memory-backed generation uses saved preferences only when current input is blank or incomplete.
- Explicit input overrides memory.
- Itinerary days match date range.
- Route legs appear for connected stops where Mapbox routing succeeds.
- Long or failed route legs are honestly labeled.
- Output includes source/evidence chips.
- Partial failure states render honestly.
- Inspiration Tray correctly parses messy pasted text and deduplicates links.

## 26. Ownership

Shaun owns:

- AI agents.
- Backend.
- Supabase schema/RLS.
- Pipeline.
- Caching/dedup.
- Auth enforcement.
- mem0 integration.
- Mapbox backend Search/Directions/Optimization calls.
- Observability.
- Agent evals.
- Deployment backend.

Zhi Hao owns:

- App UX.
- Frontend implementation.
- Inspiration Tray.
- Clipboard/share-target input flows.
- Mapbox trip view.
- Trip Brief UI.
- Generation timeline.
- Trip detail pages.
- Route visualization.
- Memory receipt/settings UI.
- Responsive layout.
- Frontend analytics.
- Landing page separately from this PRD.

Both must agree on frozen API/types before frontend-backend integration.

## 27. Milestones

### Weeks 1-2: Contracts And Foundation

Deliver:

- Final `PRD.md`.
- Backend/TS type contracts.
- Supabase schema and RLS.
- Preference source model.
- Place source model.
- Inspiration item model.
- Transport leg model.
- Memory model.
- Google OAuth.
- Dev/prod Supabase projects.
- Quota model.
- Basic CI/deploy skeleton.

### Weeks 3-4: Scrape, Extract, Resolve

Deliver:

- Direct Apify HTTP scraper.
- Reel URL normalization.
- Place extractor.
- User-requested place resolver.
- Mapbox Search Box validation.
- Evidence validation.
- Preference-free generation path.
- Inspiration Tray parser rules.
- First 10 Japan eval sets.

### Weeks 5-6: Durable Pipeline

Deliver:

- Durable jobs.
- SSE streaming.
- Progressive persistence.
- Reel/place cache.
- pgvector + geo dedup.
- Partial-trip save behavior.
- Explicit/memory/default preference context persistence.

### Weeks 7-8: Core Frontend And Map

Deliver:

- Authenticated app shell.
- Inspiration Tray.
- Clipboard paste.
- Trip Brief.
- Preference source disclosure.
- Map-first generation workspace.
- Mapbox Standard trip canvas.
- Basic route-line rendering.
- Trip detail page.
- Trip list.
- Responsive baseline.

### Week 9: Secondary Agents, Routing, And Memory

Deliver:

- Route-aware restaurants.
- Mapbox Directions route legs.
- Optional Optimization helper for flexible stop ordering.
- Weather integration.
- Orchestrator summary.
- mem0 preference memory.
- Memory receipt.
- Settings memory clear.

### Week 10: Feedback, PWA Input, And Observability

Deliver:

- PWA share target progressive enhancement.
- In-app feedback.
- Langfuse traces.
- Sentry.
- PostHog events.
- Cost logging.
- Quota dashboards through existing tools.

### Week 11: Hardening

Deliver:

- Full eval pass.
- Preference-free test pass.
- Memory-overrides test pass.
- Route sanity test pass.
- Inspiration input test pass.
- Mobile/desktop QA.
- Failure-state QA.
- Latency tuning.
- Cache warmup for demo sets.

### Week 12: Beta Launch

Deliver:

- Production deploy.
- Beta launch checklist.
- Known limitations page/copy.
- Monitoring checklist.
- Feedback review workflow.

## 28. Key Assumptions

- `PRD.md` and `DESIGN.md` do not currently exist in the repo.
- This PRD should become the first canonical product requirements doc.
- The legacy TripCanvas app is reference-only and must not be imported directly into production code.
- The legacy map-first interaction model is worth porting.
- Mapbox Standard can provide the desired premium city-canvas feel.
- Mapbox Directions is sufficient for MVP connected route visualization.
- Full public-transit planning is deferred.
- Instagram account integration and saved collection import are deferred.
- Manual paste remains the reliable required input path.
- PWA share target is useful but not guaranteed on every platform.
- The backend and frontend are currently mostly scaffolded.
- Japan-first is acceptable for v1 quality.
- Strict evidence is more important than broad recall.
- Users are okay with progressive generation if mapped value appears quickly.
- Preference memory is useful in v1 only if it is visible, controllable, and overridden by explicit current input.
