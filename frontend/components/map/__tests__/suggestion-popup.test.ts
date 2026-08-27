// components/map/__tests__/suggestion-popup.test.ts
import { describe, it, expect } from 'vitest'
import { buildStayPopup, buildEatPopup } from '@/components/map/suggestion-popup'
import type { HotelSuggestion, Place, RestaurantSuggestion } from '@/lib/trip/backend-types'

const hotel = (over: Partial<HotelSuggestion> = {}): HotelSuggestion => ({
  id: 'h1', trip_id: 't1', trip_day_id: null, base_place_id: null,
  name: 'Mitsui Garden Hotel', area: 'Ginza', star_rating: 4,
  price_snapshot: { currency: 'USD', pricePerNight: 261.49, totalPrice: 522.98 },
  travala_hotel_id: 'tv1', preference_match_json: { matched: ['central'] },
  guest_rating: 9.6, refundable: true, free_cancellation_until: '2026-09-16T14:59:00Z',
  source: 'travala', status: 'suggested', searched_at: '2026-08-01T00:00:00Z',
  lat: 35.6, lng: 139.7, geo_status: 'placed', route_score: 400, rank: 1, is_recommended: true,
  place_durations: {}, ...over,
})

const AUG = Date.parse('2026-08-27T00:00:00Z')

describe('buildStayPopup', () => {
  it('separates the star class from the guest score', () => {
    // Two different 0–10 vs 1–5 measures. Printed bare and adjacent, "4 · 9.6" invites reading
    // the second as stars, which would overstate the hotel by a factor of two.
    const text = buildStayPopup(hotel(), AUG).textContent!
    expect(text).toContain('4 star')
    expect(text).toContain('9.6/10 guest score')
  })

  it('states a cancellation deadline that is still in the future', () => {
    const text = buildStayPopup(hotel(), AUG).textContent!
    expect(text).toContain('Free cancellation until')
    expect(text).toContain('2026')
  })

  it('never presents an EXPIRED deadline as if it still stands', () => {
    // The deadline is a snapshot taken at searched_at, not a live quote. A trip reopened weeks
    // later carries a date that has passed, and "Free cancellation until 16 July" printed in
    // August is simply false — the exact kind of confident-but-wrong detail guardrail #1 targets.
    const stale = hotel({ free_cancellation_until: '2026-07-16T14:59:00Z' })
    const text = buildStayPopup(stale, AUG).textContent!
    expect(text).not.toContain('Free cancellation until')
    expect(text).toContain('Was refundable when we searched')
  })

  it('says nothing about cancellation when Travala said nothing', () => {
    const unknown = hotel({ refundable: null, free_cancellation_until: null })
    const text = buildStayPopup(unknown, AUG).textContent!
    expect(text).not.toMatch(/refundab|cancellation until/i)
  })

  it('drops a malformed price snapshot rather than printing "USD undefined"', () => {
    const broken = hotel({ price_snapshot: { currency: 'USD', pricePerNight: 'lots' } as never })
    const text = buildStayPopup(broken, AUG).textContent!
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('NaN')
  })

  it('always says the price is a search result, not a booking', () => {
    expect(buildStayPopup(hotel(), AUG).textContent).toContain('Astrail does not book')
  })
})

describe('buildEatPopup', () => {
  const place = { id: 'p1', name: 'Koma Sushi', area: 'Asakusa', city: 'Tokyo' } as Place
  const suggestion = (over: Partial<RestaurantSuggestion> = {}): RestaurantSuggestion => ({
    id: 'r1', trip_id: 't1', trip_day_id: 'd1', restaurant_place_id: 'p1', near_place_id: 'p2',
    cuisine: 'sushi', summary: 'Counter sushi near your first stop.', source_url: null,
    evidence_json: {}, preference_match_json: { matched: ['walkable'] }, ...over,
  })

  it('carries the cuisine, the address, the reason and the anchor stop', () => {
    const text = buildEatPopup(
      suggestion({ evidence_json: { address: '1-2-3 Asakusa, Taito City' } }), place, 'Senso-ji Temple',
    ).textContent!
    expect(text).toContain('sushi')
    expect(text).toContain('1-2-3 Asakusa, Taito City')     // Mapbox full_address, already stored
    expect(text).toContain('Counter sushi near your first stop.')
    expect(text).toContain('Near Senso-ji Temple')
  })

  it('shows no "matches your taste" row, because nothing ever fills it', () => {
    // persist_restaurants/persist_hotels insert `{}` literally, and a live check of both tables
    // found `{}` on every row. It rendered only for the fixture.
    const withMatches = suggestion({ preference_match_json: { matched: ['walkable'] } })
    expect(buildEatPopup(withMatches, place).textContent).not.toContain('walkable')
    expect(buildStayPopup(hotel(), AUG).textContent).not.toMatch(/matches your taste/i)
  })

  it('never prints a distance beside the anchor stop', () => {
    // `distance_m` is measured from the DAY CENTROID, not from near_place_id. "180 m from
    // Nukata Station" would be a precise-sounding falsehood.
    const withDistance = suggestion({ evidence_json: { address: 'A', distance_m: 180 } })
    expect(buildEatPopup(withDistance, place, 'Nukata Station').textContent).not.toContain('180')
  })

  it('shows opening hours and a website once the details enrichment has run', () => {
    const enriched = suggestion({
      evidence_json: { address: 'A', details: { opening_hours: 'Mon-Sat 11:30-14:00, 17:30-22:00', website: 'https://example.jp' } },
    })
    const card = buildEatPopup(enriched, place)
    expect(card.textContent).toContain('Mon-Sat 11:30')
    expect(card.querySelector('a')?.getAttribute('href')).toBe('https://example.jp/')
  })

  it('links out only when a source URL was actually recorded', () => {
    // Null on most rows in practice, so the absent case is the common one and must render clean.
    expect(buildEatPopup(suggestion(), place).querySelector('a')).toBeNull()
    const linked = buildEatPopup(suggestion({ source_url: 'https://tabelog.com/x' }), place)
    expect(linked.querySelector('a')?.getAttribute('href')).toBe('https://tabelog.com/x')
  })

  it('refuses a javascript: URL rather than rendering it as a link', () => {
    // source_url originates from model/web output, so it is not trusted input.
    const hostile = buildEatPopup(suggestion({ source_url: 'javascript:alert(1)' }), place)
    expect(hostile.querySelector('a')).toBeNull()
    expect(hostile.innerHTML).not.toContain('javascript:')
  })
})
