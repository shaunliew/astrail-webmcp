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
