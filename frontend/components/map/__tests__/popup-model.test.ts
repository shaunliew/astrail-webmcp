import { describe, it, expect } from 'vitest'
import { TOKYO_TRIP } from '@/lib/trip/fixtures/tokyo-trip'
import { buildPopupModel } from '../popup-model'
import { orderedTripPlaces } from '@/lib/trip/selectors'

const stops = orderedTripPlaces(TOKYO_TRIP)
const first = stops[0]
const second = stops[1]

describe('buildPopupModel', () => {
  it('identifies the stop by the number painted on its pin', () => {
    const m = buildPopupModel(TOKYO_TRIP, first)
    expect(m.eyebrow).toContain('Stop 1')
    expect(m.eyebrow).toContain('Day 1')
    expect(m.title).toBe('Senso-ji Temple')
  })

  it('strips caption emoji from the name', () => {
    // Real data looked like "🔍梅田藍天大樓展望台" and "📍Dekasan …" — the marker is how people
    // write Reel captions, not part of the place's name.
    const dirty = {
      ...first,
      place: { ...first.place, name: '🔍 Umeda Sky Building' },
    }
    expect(buildPopupModel(TOKYO_TRIP, dirty).title).toBe('Umeda Sky Building')
  })

  it('keeps the name if stripping would leave nothing', () => {
    const emojiOnly = { ...first, place: { ...first.place, name: '📍' } }
    expect(buildPopupModel(TOKYO_TRIP, emojiOnly).title).toBe('📍')
  })

  it('shows the local-script name as a subtitle, never duplicating the title', () => {
    const withLocal = { ...first, place: { ...first.place, name_local: '浅草寺' } }
    expect(buildPopupModel(TOKYO_TRIP, withLocal).subtitle).toBe('浅草寺')

    const same = { ...first, place: { ...first.place, name_local: first.place.name } }
    expect(buildPopupModel(TOKYO_TRIP, same).subtitle).toBeNull()
  })

  it('places the stop within its day and names the day theme', () => {
    // The whole point: a generic place card cannot say "stop 2 of 4 on a day about X".
    const m = buildPopupModel(TOKYO_TRIP, second)
    expect(m.context.join(' ')).toMatch(/Stop \d of \d on Day 1/)
  })

  it('uses the exact Reel the backend recorded, over any fallback', () => {
    // source_reel_url is the whole point of the backend fix: no more guessing which Reel.
    const exact = {
      ...first,
      evidence_json: {
        ...first.evidence_json,
        source_url: 'https://map.yahoo.co.jp/v3/place/X',
        source_reel_url: 'https://www.instagram.com/reel/EXACT/',
      },
    }
    const many = {
      ...TOKYO_TRIP,
      inspiration: [
        { ...(TOKYO_TRIP.inspiration[0] ?? ({} as never)), normalized_reel_url: 'https://www.instagram.com/reel/AAA/' },
        { ...(TOKYO_TRIP.inspiration[0] ?? ({} as never)), normalized_reel_url: 'https://www.instagram.com/reel/BBB/' },
      ],
    }
    const m = buildPopupModel(many as never, exact)
    expect(m.reel?.url).toBe('https://www.instagram.com/reel/EXACT/')
    // The research page survives, demoted and never called a Reel.
    expect(m.reference?.url).toContain('map.yahoo.co.jp')
    expect(m.reference?.label).not.toContain('Reel')
  })

  it('surfaces the Instagram Reel as the primary link', () => {
    const m = buildPopupModel(TOKYO_TRIP, first)
    expect(m.reel?.url).toContain('instagram.com')
    expect(m.reel?.label).toContain('Reel')
    expect(m.evidenceLabel).toContain('Instagram Reel')
  })

  it('never dresses a scraped website up as a Reel', () => {
    // The reported bug: an official-site URL surfaced as "Open source Reel".
    const researched = stops.find((s) => s.evidence_json.evidence_kind === 'suggested_by_astrail')
    if (!researched) return
    const m = buildPopupModel(TOKYO_TRIP, researched)
    expect(m.reference?.label).not.toContain('Reel')
    expect(m.reference?.url).not.toContain('instagram.com')
  })

  it('recovers the Reel when a trip has exactly one, even if source_url is a website', () => {
    // Enrichment can overwrite source_url with a research link. With a single Reel on the trip
    // the attribution is unambiguous, so the traveller still gets the thing they saved.
    const single = {
      ...TOKYO_TRIP,
      inspiration: [{ ...(TOKYO_TRIP.inspiration[0] ?? ({} as never)), normalized_reel_url: 'https://www.instagram.com/reel/ONLY/' }],
    }
    const researched = stops.find((s) => s.evidence_json.evidence_kind === 'suggested_by_astrail')
    if (!researched) return
    const m = buildPopupModel(single as never, researched)
    expect(m.reel?.url).toBe('https://www.instagram.com/reel/ONLY/')
  })

  it('refuses to guess WHICH Reel when a trip has several', () => {
    // A wrong citation under a verbatim quote is worse than no citation.
    const many = {
      ...TOKYO_TRIP,
      inspiration: [
        { ...(TOKYO_TRIP.inspiration[0] ?? ({} as never)), normalized_reel_url: 'https://www.instagram.com/reel/AAA/' },
        { ...(TOKYO_TRIP.inspiration[0] ?? ({} as never)), normalized_reel_url: 'https://www.instagram.com/reel/BBB/' },
      ],
    }
    const researched = stops.find((s) => s.evidence_json.evidence_kind === 'suggested_by_astrail')
    if (!researched) return
    expect(buildPopupModel(many as never, researched).reel).toBeNull()
  })

  it('omits the image unless the trip still holds that Reel', () => {
    const m = buildPopupModel(TOKYO_TRIP, first)
    expect(m.imageUrl).toBeNull()

    const withThumb = {
      ...TOKYO_TRIP,
      inspiration: [
        {
          ...(TOKYO_TRIP.inspiration[0] ?? ({} as never)),
          normalized_reel_url: first.evidence_json.source_url,
          thumbnail_url: 'https://cdn.example/thumb.jpg',
        },
      ],
    }
    expect(buildPopupModel(withThumb as never, first).imageUrl).toBe('https://cdn.example/thumb.jpg')
  })

  it('answers "where do I eat around here" on the map, not only in the panel', () => {
    const m = buildPopupModel(TOKYO_TRIP, first)
    expect(Array.isArray(m.eats)).toBe(true)
  })

  it('puts a suggestion anchored to THIS stop ahead of the rest of the day', () => {
    // near_place_id exists precisely to tie a suggestion to a stop; ignoring it would make
    // "nearby" mean "somewhere on this day", which is not what someone clicking a pin is asking.
    const day1 = TOKYO_TRIP.days[0]
    const withEats = {
      ...TOKYO_TRIP,
      restaurants: [
        { ...TOKYO_TRIP.restaurants[0], id: 'r-far', trip_day_id: day1.id, near_place_id: 'someone-else', summary: 'Far Diner', cuisine: 'ramen', restaurant_place_id: null },
        { ...TOKYO_TRIP.restaurants[0], id: 'r-near', trip_day_id: day1.id, near_place_id: first.place.id, summary: 'Right Here Cafe', cuisine: 'cafe', restaurant_place_id: null },
      ],
    }
    const m = buildPopupModel(withEats as never, first)
    expect(m.eats[0].name).toBe('Right Here Cafe')
    expect(m.eats.map((e) => e.name)).toContain('Far Diner')
  })

  it('caps the eats list so the popup stays readable', () => {
    const day1 = TOKYO_TRIP.days[0]
    const many = {
      ...TOKYO_TRIP,
      restaurants: Array.from({ length: 8 }, (_, i) => ({
        ...TOKYO_TRIP.restaurants[0], id: `r-${i}`, trip_day_id: day1.id,
        near_place_id: null, summary: `Place ${i}`, cuisine: null, restaurant_place_id: null,
      })),
    }
    expect(buildPopupModel(many as never, first).eats.length).toBeLessThanOrEqual(3)
  })

  it('reports confidence as a whole percent', () => {
    expect(buildPopupModel(TOKYO_TRIP, first).confidence).toBe(94)
  })

  it('says so plainly when there is no quote, rather than showing an empty card', () => {
    const noQuote = { ...first, evidence_json: { ...first.evidence_json, quote: null, rationale: null } }
    expect(buildPopupModel(TOKYO_TRIP, noQuote).evidence).toContain('No caption quote')
  })

  it('invents no opening hours, price or rating', () => {
    // Guardrail #1 applies hardest here: this is the surface that promises every claim has
    // evidence. None of those fields exists in the schema, so none may appear.
    const m = buildPopupModel(TOKYO_TRIP, first)
    const blob = JSON.stringify(m).toLowerCase()
    for (const invented of ['open until', 'opening hours', 'rating', '★', 'price']) {
      expect(blob).not.toContain(invented)
    }
  })
})
