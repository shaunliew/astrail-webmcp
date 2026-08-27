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

  it('recovers the Reel for a REEL-sourced stop whose source_url is a website', () => {
    // Enrichment overwrites source_url with a research link. For a stop that genuinely came
    // from a Reel, a trip with exactly one Reel makes the attribution unambiguous, so the
    // traveller still gets the thing they saved. (Only reel-derived stops qualify — see the
    // test above; citing a Reel for a place the user typed would be a false citation.)
    const single = {
      ...TOKYO_TRIP,
      inspiration: [{ ...(TOKYO_TRIP.inspiration[0] ?? ({} as never)), normalized_reel_url: 'https://www.instagram.com/reel/ONLY/' }],
    }
    const reelSourced = {
      ...first,
      evidence_json: {
        ...first.evidence_json,
        evidence_kind: 'reel_quote' as const,
        source_url: 'https://map.yahoo.co.jp/v3/place/X',
        source_reel_url: null,
      },
    }
    expect(buildPopupModel(single as never, reelSourced).reel?.url).toBe('https://www.instagram.com/reel/ONLY/')
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

  it('shows the source Reel frame, and labels it as the Reel rather than the place', () => {
    // Product decision: one Reel yields one cover, so several stops from the same Reel share a
    // frame. That is acceptable because of HOW it is presented — as the source we found the
    // place in, not as a portrait of the venue. The label is what carries that, so it is
    // asserted alongside the image; if the framing ever changes, the image needs rethinking too.
    const twoFromOneReel = {
      ...TOKYO_TRIP,
      places: stops.slice(0, 2).map((tp) => ({
        ...tp,
        evidence_json: {
          ...tp.evidence_json,
          evidence_kind: 'reel_quote' as const,
          source_reel_url: 'https://www.instagram.com/reel/SHARED/',
        },
      })),
      inspiration: [{
        ...(TOKYO_TRIP.inspiration[0] ?? ({} as never)),
        normalized_reel_url: 'https://www.instagram.com/reel/SHARED/',
        thumbnail_url: 'https://cdn.example/cover.jpg',
      }],
    }
    for (const tp of twoFromOneReel.places) {
      const m = buildPopupModel(twoFromOneReel as never, tp)
      expect(m.imageUrl).toBe('https://cdn.example/cover.jpg')
      expect(m.evidenceLabel).toBe('From your Instagram Reel')
      expect(m.reel?.url).toBe('https://www.instagram.com/reel/SHARED/')
    }
  })

  it('uses the cover when a Reel contributed exactly one place — then it really is that place', () => {
    const oneFromOneReel = {
      ...TOKYO_TRIP,
      places: [{
        ...first,
        evidence_json: { ...first.evidence_json, source_reel_url: 'https://www.instagram.com/reel/SOLO/' },
      }],
      inspiration: [{
        ...(TOKYO_TRIP.inspiration[0] ?? ({} as never)),
        normalized_reel_url: 'https://www.instagram.com/reel/SOLO/',
        thumbnail_url: 'https://cdn.example/cover.jpg',
      }],
    }
    expect(buildPopupModel(oneFromOneReel as never, oneFromOneReel.places[0]).imageUrl)
      .toBe('https://cdn.example/cover.jpg')
  })

  it('never cites a Reel for a place that did not come from one', () => {
    // The legacy single-Reel fallback used to apply to every place, so a stop the user typed
    // would be captioned with someone else's Reel.
    const added = {
      ...first,
      evidence_json: {
        ...first.evidence_json,
        evidence_kind: 'requested_by_you' as const,
        source_url: null, source_reel_url: null,
      },
    }
    const trip = {
      ...TOKYO_TRIP,
      inspiration: [{ ...(TOKYO_TRIP.inspiration[0] ?? ({} as never)), normalized_reel_url: 'https://www.instagram.com/reel/OTHER/' }],
    }
    expect(buildPopupModel(trip as never, added).reel).toBeNull()
  })

  // The URL fields alone were enough to earn a Reel citation, because provenance was checked
  // only on the legacy fallback. A row can hold an Instagram URL without having come from that
  // Reel: `source_url` is the research page for agent picks, dedup can rewrite source_type to
  // user_requested while the representative's Reel URL survives, and rows reach the client
  // through an unvalidated cast. Each of these would have shown the brass "from Reel" frame.
  it.each([
    ['a stop the user asked for', 'user_requested', 'requested_by_you'],
    ['a stop Astrail suggested', 'agent_suggested', 'suggested_by_astrail'],
  ])('cites no Reel for %s that merely carries an Instagram URL', (_label, sourceType, kind) => {
    const reel = TOKYO_TRIP.inspiration.find((i) => i.normalized_reel_url)!
    for (const field of ['source_reel_url', 'source_url'] as const) {
      const row = {
        ...first,
        source_type: sourceType as never,
        evidence_json: {
          ...first.evidence_json,
          evidence_kind: kind as never,
          source_url: null,
          source_reel_url: null,
          [field]: reel.normalized_reel_url,
        },
      }
      const model = buildPopupModel(TOKYO_TRIP as never, row as never)
      expect(model.reel, `${sourceType} via ${field}`).toBeNull()
      expect(model.imageUrl, `${sourceType} via ${field}`).toBeNull()
    }
  })

  // Inconsistent row: dedup rewrote source_type but the representative's reel_quote survived.
  it('cites no Reel when source_type and evidence_kind disagree', () => {
    const reel = TOKYO_TRIP.inspiration.find((i) => i.normalized_reel_url)!
    const row = {
      ...first,
      source_type: 'user_requested' as never,
      evidence_json: {
        ...first.evidence_json,
        evidence_kind: 'reel_quote' as const,          // stale — survived the source_type rewrite
        source_reel_url: reel.normalized_reel_url,
      },
    }
    expect(buildPopupModel(TOKYO_TRIP as never, row as never).imageUrl).toBeNull()
  })

  it('omits the image when the trip no longer holds that Reel', () => {
    // The cover comes from the trip's own inspiration rows. If the Reel is not among them there
    // is no image to show, and nothing else may be substituted.
    const dropped = {
      ...TOKYO_TRIP,
      inspiration: [{
        ...(TOKYO_TRIP.inspiration[0] ?? ({} as never)),
        normalized_reel_url: 'https://www.instagram.com/reel/SOMETHING_ELSE/',
        thumbnail_url: 'https://cdn.example/other.jpg',
      }],
    }
    expect(buildPopupModel(dropped as never, first).imageUrl).toBeNull()
  })

  it('reports confidence as a whole percent', () => {
    expect(buildPopupModel(TOKYO_TRIP, first).confidence).toBe(94)
  })

  it('says so plainly when there is no quote, rather than showing an empty card', () => {
    const noQuote = { ...first, evidence_json: { ...first.evidence_json, quote: null, rationale: null } }
    expect(buildPopupModel(TOKYO_TRIP, noQuote).evidence).toContain('No caption quote')
  })

  it('does not quote a user-added place\'s own name back as evidence', () => {
    // Reported: adding Osaka Castle produced "Why it is here / Osaka Castle / Confidence 100%".
    // The name is not evidence, and 100% confidence in a name the user typed says nothing.
    const added = {
      ...first,
      evidence_json: {
        ...first.evidence_json,
        evidence_kind: 'requested_by_you' as const,
        quote: 'Osaka Castle',
        confidence: 1,
        source_url: null,
        source_reel_url: null,
      },
      place: { ...first.place, name: 'Osaka Castle' },
    }
    const m = buildPopupModel(TOKYO_TRIP, added)
    expect(m.evidenceLabel).toBe('Added by you')
    expect(m.evidence).toContain('You asked for this stop')
    expect(m.evidence).not.toBe('Osaka Castle')
    expect(m.confidence).toBeNull()
    expect(m.reel).toBeNull()
  })

  it('still shows confidence for a Reel-derived stop', () => {
    expect(buildPopupModel(TOKYO_TRIP, first).confidence).toBe(94)
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
