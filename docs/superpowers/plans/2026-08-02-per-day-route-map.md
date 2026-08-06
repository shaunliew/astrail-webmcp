# Plan — Per-day route map (trip workspace)

**Date:** 2026-08-02 · **Branch:** zh · **Owner:** Zhi Hao (frontend)
**Type:** Frontend feature · pure view logic, no schema/API/SSE change
**Roadmap:** `docs/roadmap/trip-map-day-connections.md` (this reverses part of the 2026-08-01 beta decision)

## Why

Trip planning is a day-unit activity — users decide "what do I do on Day 2", not "read my
whole trip as one blob". Today the workspace map does the opposite: it draws one global
constellation through every stop, numbers pins globally 1..N, and a day tab only pans the
camera (`TripMap.tsx:189-201`). Meanwhile the day panel numbers stops per-day
(`ItineraryCards.tsx:55`, `01/02`), so the map pin ("5") and the panel item ("01") disagree
for any Day 2+ stop — the mismatch `/qa` surfaced on 2026-08-02.

Make the map **day-scoped**: open on the whole-journey overview (orientation + the
constellation moment), click a day to focus that day's route with per-day numbering that
matches the panel by construction. This is also the honest stepping stone to the
hotel-as-parent-hub end state (roadmap Phase B), which is inherently per-day.

## Decisions from the interview (2026-08-02)

- **Entry = overview.** Open on the all-days global constellation (global 1..N). Click a day
  to focus. An "All days" control returns to overview. → Map keeps **two numbering modes**:
  global in overview, per-day in day-focus.
- **Focus a day → dim the others.** Other days' pins stay faintly visible for geographic
  context (not hidden), de-emphasized and unnumbered. Only the active day's pins carry
  numbers and its route line draws.
- **Numbering agrees by construction.** Day-focus map numbers and panel `01/02` both derive
  from `placesForDay(bundle, N)` sort order → identical.
- **Stay transport-leg-independent.** Day route is a straight line through the day's stops
  (same as beta's trail, day-scoped), so it connects on the common 0-leg / `saved_with_gaps`
  trips.
- **Camera:** overview fits all stops; day-focus fits that day's stops (reuse existing
  `frame()`/`fitBounds`).
- **"All days" control:** a chip at the head of the existing Day tab row (`DaySelector`).

## Non-goals (defer — roadmap phases)

- Hotel-as-parent-hub / star topology (Phase B) — needs hotel coords first.
- Smart per-day sequencing (TSP) + real Mapbox Directions geometry (Phase C).
- Per-day color hues / multi-trail overview polish (Phase D).
- Backend `transport_legs` being empty — separate; flag to Shaun, not this work.

## Guardrail check

- No schema / API / SSE / auth / RLS change — pure client view logic (Schema-parity N/A).
- No hallucinated places: numbering/dim only re-labels existing resolved-coord pins;
  `hasRealCoords` filtering unchanged (`selectors.ts:49`).
- Evidence surfacing untouched (`ItineraryCards` evidence chips unchanged).
- Feasible-first: reuse `placesForDay`, `orderedTripPlaces`, `frame()`; add one selector and
  one CSS modifier; no new deps, no schema.

## Design

**State (`TripWorkspace.tsx`).** `activeDayNumber` becomes `number | null` (`null` = overview).
Entry defaults to `null` (was `orderedDays(b)[0]?.day_number ?? 1`, line 63/75). Guard
`dayPlaces` so `null` yields `[]` (today `placesForDay(bundle, null)` would wrongly return the
undayed hotel). Day-scoped strips already null-guard via `activeDay`.

**New selector (`selectors.ts`).** One centralized, testable pin model so `TripMap` stays thin:

```ts
export type PinModel = { number: number | null; dimmed: boolean }

// overview (activeDay === null): every resolved stop keyed to its GLOBAL trail number,
//   not dimmed; hotel/unresolved -> {null, false} (receding, as today).
// day N: day-N resolved stops -> {perDayIndex, false}; other-day resolved stops ->
//   {null, true} (dimmed context dots); hotel/unresolved -> {null, false} (receding).
export function buildPinModel(bundle, activeDay: number | null): Map<string, PinModel>

// stops the trail line threads: overview -> orderedTripPlaces (full constellation);
// day N -> placesForDay(N) filtered to real coords (the day's route).
export function trailStops(bundle, activeDay: number | null): TripPlace[]
```

Keep `buildTrailNumbers` / `pinLabelForPlace` (used by overview + existing tests).

**`TripMap.tsx`.** Prop `activeDayNumber: number | null`. `drawMarkers()` consumes
`buildPinModel` — class list gains `constellation-pin--dimmed` when `dimmed`; number text and
`--receding` logic derive from the model. `drawTrail()` threads `trailStops(bundle,
activeDayNumber)` (≥2 stops or no line). The day-change effect now **redraws markers + trail
+ reframes** (not camera-only): overview → fit all (`flyToTrip`), day → `frame(pointsForDay(N))`.

**`DaySelector.tsx`.** Props `activeDayNumber: number | null`, `onSelect: (n: number | null)
=> void`. Prepend an "All days" tab (active when `activeDayNumber === null`, `onClick →
onSelect(null)`), styled with the existing active/inactive chip classes.

**`ItineraryCards.tsx`.** No numbering change — day-focus map numbers already match its
`01/02` by shared `placesForDay` order. A test pins this invariant.

**Panel overview state.** When `activeDayNumber === null`, the Itinerary section shows a
one-line hint ("Tap a day to focus its route") instead of the empty "No stops planned"
message; trip-level sections (Astrail's read, Tradeoffs, Hotels, Agent rail) render as today.

**CSS (`app/globals.css`, near line 533).** Add `.constellation-pin--dimmed` — a subtle
context dot: `opacity: ~0.3`, `~18px`, `font-size: 0` (no number), no glow. Distinct from
`--receding` (hotel/unresolved). Active-day pins keep the full 26px numbered style.

## Tasks (TDD, task-by-task)

**T1 — selectors: `buildPinModel` + `trailStops` (+ tests).**
`selectors.ts`. Add both functions and `PinModel` type; keep global helpers.
Tests (`lib/trip/__tests__/selectors.test.ts`): overview → global numbers, none dimmed,
hotel null; day 2 → day-2 stops per-day-indexed (1..k) undimmed, other days null+dimmed,
hotel `{null,false}`; `trailStops` overview = full ordered, day = that day's resolved stops;
1-stop day → single stop (no line upstream).

**T2 — DaySelector: "All days" chip.**
`DaySelector.tsx` + `__tests__/DaySelector.test.tsx`. `number|null` props; "All days" tab
renders first, active when null, fires `onSelect(null)`; day tabs still fire their number.

**T3 — TripWorkspace: overview state + wiring.**
`TripWorkspace.tsx` + `__tests__/TripWorkspace.test.tsx`. `activeDayNumber: number|null`,
entry `null`, `dayPlaces` guard, overview Itinerary hint, pass `number|null` to
`DaySelector`/`TripMap`. Test: mounts in overview (null), day click sets the number, "All
days" returns to null.

**T4 — TripMap: day-scoped markers + trail + reframe.**
`TripMap.tsx` + `__tests__/TripMap.test.tsx`. Consume `buildPinModel`/`trailStops`; prop
type `number|null`; day-change effect redraws + reframes. Tests: overview draws full trail +
global numbers; switching to day N redraws to that day's line, numbers day-N pins per-day,
adds `--dimmed` to other-day pins; 0-leg trip still draws the day line.

**T5 — CSS: `--dimmed` modifier.**
`app/globals.css` (~line 533). Add `.constellation-pin--dimmed`. No test (visual; covered by
T4 class assertion + browser QA).

**T6 — Roadmap doc.**
`docs/roadmap/trip-map-day-connections.md`. Update the beta section to describe day-scoped
focus + per-day numbering + overview toggle; add a **Decisions log** entry (2026-08-02)
recording the reversal of the 2026-08-01 global-numbering / camera-only call, with the "why"
(user-facing: day-unit planning; forward-compatible with Phase B).

**T7 — Verify.**
`npm run test` (full suite green — expect updates in selectors/DaySelector/TripWorkspace/
TripMap/ItineraryCards specs) + `npm run typecheck`. Then browser `/qa` on the trip flow
(evidence below).

## Test plan

- Unit: T1-T4 specs above. Add an **invariant test**: for a multi-day fixture, the map's
  day-N pin numbers (`buildPinModel(bundle, N)`) equal the panel's `String(i+1)` order over
  `placesForDay(bundle, N)` — proves map↔panel agreement by construction.
- Keep the existing global-numbering tests (`selectors.test.ts:62-68`) — still valid for
  overview.

## Browser QA (`/qa`, required — Mapbox + full-flow change)

Open a trip → **overview**: full constellation, global 1..N, camera fits all. Click Day 2 →
map redraws to Day 2's line, Day 2 pins numbered 1..k **matching the panel's 01/02**, other
days **dimmed** not gone, camera fits Day 2. Click "All days" → back to overview. Verify on a
**0-leg `saved_with_gaps` trip** the day line still draws. Reduced-motion still frames (no
stranded camera). Screenshots to `.gstack/qa-reports/`.

## Rollback risk — LOW

Pure frontend view logic; no schema/API/SSE/auth. Revert = restore global numbering +
camera-only day effect (the reverted decision). Tests pin the new behavior. Blast radius is
the trip workspace map + day panel only; the trips dashboard map (`TripMapDashboard`) is
untouched.

## Files touched

- `frontend/lib/trip/selectors.ts` (+ test)
- `frontend/components/trip/DaySelector.tsx` (+ test)
- `frontend/components/trip/TripWorkspace.tsx` (+ test)
- `frontend/components/map/TripMap.tsx` (+ test)
- `frontend/app/globals.css`
- `docs/roadmap/trip-map-day-connections.md`
- (`frontend/components/trip/ItineraryCards.tsx` — no change; invariant test only)
