import { describe, it, expect } from 'vitest'
import { TOKYO_TRIP } from '@/lib/trip/fixtures/tokyo-trip'
import { TOKYO_TRIP_WITH_HOTELS } from '@/lib/trip/fixtures/tokyo-hotels'

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

  it('has a baked partial failure: an unroutable leg and a dayless forecast (PRD §17)', () => {
    expect(TOKYO_TRIP.transport_legs.some((l) => l.status === 'no_route')).toBe(true)
    expect(TOKYO_TRIP.days.some((d) => d.weather_source === 'none')).toBe(true)
  })

  /* Hotel search ships OFF, and the disabled arm clears whatever an earlier run persisted, so a
     trip generated today has no hotel rows — the demo bundle carries none because it is what a
     real trip carries. The skipped-hotel failure case did not go away with it; it moved to the
     pre-switch bundle, which is still the shape of every trip generated before 2026-08-30. */
  it('carries no hotels, the way a trip generated today does not', () => {
    expect(TOKYO_TRIP.hotels).toEqual([])
    expect(TOKYO_TRIP.trip.tradeoffs.comparisons).toEqual([])
  })

  it('keeps the skipped-hotel partial failure on the pre-switch bundle (PRD §17)', () => {
    expect(TOKYO_TRIP_WITH_HOTELS.hotels.some((h) => h.status === 'skipped')).toBe(true)
  })

  /* Two days, not three. Two Reels' worth of extracted places spread over three days read as a
     sparse trip — a judge sees thinness and concludes the pipeline found little, which is the
     opposite of what the sample trail is for. Same content, fuller days. */
  it('runs over two days, so the extracted places read as a trip and not a sample', () => {
    expect(TOKYO_TRIP.days).toHaveLength(2)
    expect(TOKYO_TRIP.days.map((d) => d.day_number)).toEqual([1, 2])
    // The window has to agree, or every day-in-range check below is checking a wider trip.
    expect(TOKYO_TRIP.trip.end_date).toBe(TOKYO_TRIP.days[1].day_date)
  })

  /* THE FOLD THIS FIXTURE FEEDS. `ItineraryCards::buildRouteLinks` claims "the leg that BRINGS
     you to this stop", which covers two shapes: a hop between consecutive stops, and the arrival
     into a day's FIRST stop from the previous day's last one. A fold matching consecutive pairs
     alone silently drops the second — and with it that day's routing warning — and that bug
     shipped once already.

     `ItineraryCards.test.tsx` pins the fold against this fixture, so the fixture has to keep
     supplying the shape: if the day boundaries ever move so that no leg spans two days, that test
     goes on passing while watching nothing. This asserts the raw property the test depends on,
     with no rendering in the way. */
  it('keeps a leg that spans two days, which the route-link fold is pinned against', () => {
    const dayOf = new Map(TOKYO_TRIP.days.map((d) => [d.id, d.day_number]))
    const dayOfPlace = new Map(TOKYO_TRIP.places.map((tp) => [tp.place_id, tp.day_number]))

    const crossDay = TOKYO_TRIP.transport_legs.filter((l) => {
      const legDay = dayOf.get(l.trip_day_id!)
      const originDay = dayOfPlace.get(l.from_place_id!)
      return legDay !== undefined && originDay != null && originDay !== legDay
    })
    expect(crossDay.length, 'no leg arrives from another day — the fold test is watching nothing').toBeGreaterThan(0)

    // And it still lands on the FIRST stop of its day: that is the position the fold has to
    // reach past the previous card to find. A cross-day leg into a later stop is a different case.
    for (const leg of crossDay) {
      const legDay = dayOf.get(leg.trip_day_id!)!
      const stops = TOKYO_TRIP.places
        .filter((tp) => tp.day_number === legDay)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      expect(leg.to_place_id).toBe(stops[0].place_id)
    }
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

  it('all place references resolve within the bundle', () => {
    /* Suggestion targets resolve through `suggestion_places`, NOT through the trip's stops —
       the same union `buildPlaceIndex` uses. Requiring a restaurant to BE a stop encoded the
       opposite of how real trips look (every restaurant suggestion on the reported Osaka trip
       points at a place that is not a stop) and is why the "Where to eat" markers went
       untested: a fixture where they all resolve to stops builds no eat markers at all. */
    const ids = new Set([
      ...TOKYO_TRIP.places.map((p) => p.place_id),
      ...TOKYO_TRIP.suggestion_places.map((p) => p.id),
    ])
    const stopIds = new Set(TOKYO_TRIP.places.map((p) => p.place_id))
    for (const l of TOKYO_TRIP.transport_legs) {
      if (l.from_place_id) expect(stopIds.has(l.from_place_id)).toBe(true)
      if (l.to_place_id) expect(stopIds.has(l.to_place_id)).toBe(true)
    }
    for (const r of TOKYO_TRIP.restaurants) {
      if (r.restaurant_place_id) expect(ids.has(r.restaurant_place_id)).toBe(true)
      if (r.near_place_id) expect(ids.has(r.near_place_id)).toBe(true)
    }
    for (const h of TOKYO_TRIP.hotels) {
      if (h.base_place_id) expect(stopIds.has(h.base_place_id)).toBe(true)
    }
  })

  it('ok legs carry geometry matching their endpoints', () => {
    const byId = new Map(TOKYO_TRIP.places.map((p) => [p.place_id, p.place]))
    for (const l of TOKYO_TRIP.transport_legs) {
      if (l.status !== 'ok') continue
      expect(l.route_geometry).not.toBeNull()
      const from = byId.get(l.from_place_id!)!
      const to = byId.get(l.to_place_id!)!
      const coords = l.route_geometry!.coordinates
      expect(coords[0]).toEqual([from.lng, from.lat])
      expect(coords[coords.length - 1]).toEqual([to.lng, to.lat])
      // Road-shaped, not pin-to-pin: the mock dogleg must carry intermediate points
      // (mirrors what Mapbox Directions returns once the backend ships issue #42).
      expect(coords.length).toBeGreaterThan(2)
    }
  })

  it('every referenced trip_day_id exists', () => {
    const dayIds = new Set(TOKYO_TRIP.days.map((d) => d.id))
    const referenced = [
      ...TOKYO_TRIP.transport_legs.map((l) => l.trip_day_id),
      ...TOKYO_TRIP.restaurants.map((r) => r.trip_day_id),
      ...TOKYO_TRIP.hotels.map((h) => h.trip_day_id),
    ].filter((x): x is string => x !== null)
    for (const id of referenced) expect(dayIds.has(id)).toBe(true)
  })
})
