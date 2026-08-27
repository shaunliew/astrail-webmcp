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

  it('labels a Reel-sourced link as the Reel, not as generic research', () => {
    const m = buildPopupModel(TOKYO_TRIP, first)
    expect(m.source?.url).toContain('instagram.com')
    expect(m.source?.label).toContain('Reel')
    expect(m.evidenceLabel).toContain('Instagram Reel')
  })

  it('does NOT call a scraped website a Reel', () => {
    // The reported bug: an official-site URL was surfaced as "Open source Reel".
    const researched = stops.find((s) => s.evidence_json.evidence_kind === 'suggested_by_astrail')
    if (!researched) return
    const m = buildPopupModel(TOKYO_TRIP, researched)
    expect(m.source?.label).not.toContain('Reel')
    expect(m.evidenceLabel).not.toContain('Reel')
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
