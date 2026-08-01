# Trip map — connecting the pins (day-by-day routing roadmap)

**Status:** Beta shipped (constellation trail) · hub + smart-routing phases pending
**Owner:** Zhi Hao (frontend) · needs Shaun (backend) + Travala for the later phases
**Last updated:** 2026-08-01

> "Astrail turns scattered travel inspiration into the route you actually take." The map is
> where that promise gets literal — this doc tracks how the pins go from scattered dots to a
> real, agent-planned route.

---

## Problem

On the trip workspace map, every place shows as a standalone pin with nothing connecting
them. Two causes:

1. **Connections were transport-leg driven.** The old `drawRoutes()` only drew a line where
   the backend had produced a `TransportLeg` row (`from_place_id → to_place_id`, scoped to a
   `trip_day_id`). Many trips — especially the common **`saved_with_gaps`** ones — come back
   with **0 legs**, so nothing drew and all pins floated.
2. **Legs could span days.** When they existed, a leg's endpoints weren't guaranteed to be
   that day's pins (e.g. a Day-3 leg starting at a Day-2 place), so the line read incoherently.

The pins were also numbered **per active day** (each day restarted at 1) with non-active-day
pins dimmed — so there was no way to read the whole journey at a glance.

---

## Beta — the constellation trail (shipped)

The simplest thing that always connects: **one continuous line through every stop in journey
order, independent of transport data.** On brand — it literally draws the constellation the
product is named for.

**What it does**
- Orders every dayed, resolved-coordinate stop across **all** days by `(day_number,
  sort_order)` — Day 1's first stop through the last day's final stop.
- Draws **one** brass line (soft casing + dashed core) threading them in that order.
- Numbers pins **globally, 1…N** — the last stop carries the highest number, so the pins read
  as one sequence you can follow end to end. All stops stay lit; the active day is emphasized
  by the **camera** (fly-to), not by dimming the others.
- **Ignores transport legs entirely**, so it connects even on 0-leg trips.

**Deliberately excluded from the trail**
- The **base hotel** (`day_number = null`) — stays a standalone, receding pin for now. It
  becomes the hub in a later phase, not a stop on the line.
- **Unresolved coordinates** (missing / `(0,0)` / out-of-range) — never pinned, never on the
  line, never allowed to blow out the map bounds.

**Files**
- `frontend/lib/trip/selectors.ts` — `orderedTripPlaces()`, `buildTrailNumbers()`,
  `hasRealCoords()` (promoted from `TripMap`), and `pinLabelForPlace()` reworked to global.
- `frontend/components/map/TripMap.tsx` — `drawRoutes()` → `drawTrail()`; markers now use
  global trail numbers; the day-change effect only moves the camera (trail is day-independent).
- Tests: `lib/trip/__tests__/selectors.test.ts`, `components/map/__tests__/TripMap.test.tsx`.

**Explicitly *not* in beta:** real per-hop routing, the hotel hub, per-day colors, cross-day
connectors. The trail is an honest placeholder that upgrades cleanly into the model below.

---

## Next — hotel-as-hub + smart day routing

The real vision (think Grab's map): the agent plans each day and the map shows how you
actually move, anchored on where you sleep.

### Phase A — Give the hotel a location
The base hotel currently has no reliable `lat`/`lng`, so it can't anchor anything.
- **Preferred:** ask the Travala dev to expose the hotel's coordinates in the search result.
- **Fallback:** geocode the hotel ourselves (name + area → Mapbox Geocoding) and persist it
  write-through, same as other place coords.
- **Guardrail:** the hotel pin only enters the routing model once it has *verified* coords —
  no hallucinated location (Guardrail #1).

### Phase B — Hotel as parent hub (star topology)
Once the hotel has coords, flip it from "a floating pin" to the **parent** node each day's
stops **branch out from** and return to:

```
        ┌── ① Senso-ji
 [Hotel]├── ② teamLab
        └── ③ Shibuya Sky
```

- Each day is a hub-and-spoke from the hotel to that day's stops (hotel → stops → hotel),
  not one long snake across unrelated days.
- Distinguish the hotel with a dedicated "base" marker (home glyph), separate from numbered
  stops.

### Phase C — Smart routing (the agent's job)
The agent sequences and routes each day intelligently:
- Order a day's stops to **minimize travel** (nearest-neighbour / TSP-ish over the day's
  set), instead of trusting raw `sort_order`.
- Pick the **transport mode per hop** (walk / transit / drive) and surface **the shortest /
  most sensible route** — real Mapbox Directions geometry per hop.
- Emit these as `TransportLeg` rows so the map can draw **real routed geometry**, upgrading
  each trail segment from the straight beta link to the actual path. (Backend work — pairs
  with the multi-agent pipeline; see `.claude/docs/ARCHITECTURE.md`.)

### Phase D — Whole-trip overview polish (optional)
- Per-day color/hue so multiple days read as distinct trails; selected day brightest, others
  recede.
- Cross-day continuity treatment (e.g. a faint overnight connector back to the hotel).

---

## Dependencies & open questions

- **[blocking Phase A]** Travala hotel lat/lng — confirm with the Travala dev whether the
  search result can include coordinates; if not, we geocode.
- **[Phase C, backend]** Who owns leg generation + per-day sequencing — the enrich/transport
  pipeline stage. Needs `TransportLeg` rows with `route_geometry` for the map to upgrade.
- **Multi-base trips:** the current model assumes one base hotel for the whole trip. Trips
  that change cities mid-way need a hotel *per segment* — deferred until it comes up.
- **Numbering vs. smart order:** beta numbers by `sort_order`; once Phase C reorders stops
  for efficiency, the numbers follow the optimized order (still global 1…N).

---

## Decisions log

- **2026-08-01** — Beta = ordered constellation trail (global numbering, no transport-leg
  dependency, hotel excluded, camera unchanged). Agreed the hotel-hub + smart routing is the
  north star but out of scope for beta; the trail upgrades into it rather than being thrown
  away.
