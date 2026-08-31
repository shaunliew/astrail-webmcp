import { describe, it, expect, vi } from 'vitest'
import { TOKYO_TRIP } from '@/lib/trip/fixtures/tokyo-trip'
import { placesForDay } from '@/lib/trip/selectors'
import type { TripBundle } from '@/lib/trip/backend-types'
import { envelopeLength, OUTPUT_LIMIT } from '../fit'
import { getItineraryTool, getPlaceEvidenceTool, type TripReader } from '../tools/trips'

const FULL = TOKYO_TRIP.trip.id
const SHORT = FULL.slice(0, 8) // exactly what list_trips prints back to the agent

const reader = (over: Partial<TripReader> = {}): TripReader => ({
  current: () => null,
  list: async () => [TOKYO_TRIP.trip],
  load: async (id) => (id === FULL ? TOKYO_TRIP : null),
  ...over,
})

describe('get_itinerary — resolving which trip', () => {
  it('accepts the 8-char short id that list_trips prints', async () => {
    // The budget forces list_trips to emit a prefix, so the agent can only ever hand one back.
    const out = await getItineraryTool(reader()).execute({ trip_id: SHORT })
    expect(String(out)).toContain('Akasaka Station')
  })

  it('accepts the full uuid too', async () => {
    const out = await getItineraryTool(reader()).execute({ trip_id: FULL })
    expect(String(out)).toContain('Akasaka Station')
  })

  it('uses the open trip when no id is given', async () => {
    const load = vi.fn()
    const out = await getItineraryTool(reader({ current: () => TOKYO_TRIP, load })).execute({})
    expect(String(out)).toContain('Akasaka Station')
    expect(load).not.toHaveBeenCalled() // already in memory; no round-trip
  })

  it('asks which trip rather than guessing when none is open', async () => {
    const out = await getItineraryTool(reader()).execute({})
    expect(String(out)).toContain('Call list_trips')
  })

  it('reports an unknown id instead of silently returning nothing', async () => {
    const out = await getItineraryTool(reader()).execute({ trip_id: 'deadbeef' })
    expect(String(out)).toContain('No trip with id')
  })

  it('refuses an ambiguous prefix rather than picking one', async () => {
    const t2 = { ...TOKYO_TRIP.trip, id: `${FULL.slice(0, 8)}ffff-0000-0000-000000000000` }
    const out = await getItineraryTool(reader({ list: async () => [TOKYO_TRIP.trip, t2] })).execute({
      trip_id: SHORT,
    })
    expect(String(out)).toContain('matches 2 trips')
  })

  it('avoids a network load when the open trip already matches the id', async () => {
    const load = vi.fn()
    await getItineraryTool(reader({ current: () => TOKYO_TRIP, load })).execute({ trip_id: SHORT })
    expect(load).not.toHaveBeenCalled()
  })

  it('surfaces a failed load honestly', async () => {
    const out = await getItineraryTool(reader({ load: async () => null })).execute({ trip_id: SHORT })
    expect(String(out)).toContain('could not be loaded')
  })

  it('scopes to one day when asked', async () => {
    const out = await getItineraryTool(reader()).execute({ trip_id: SHORT, day: 2 })
    expect(String(out)).toContain(placesForDay(TOKYO_TRIP, 2)[0].place.name)
    expect(String(out)).not.toContain('D1 ')
  })
})

describe('get_place_evidence', () => {
  it('returns the verbatim caption quote and its source', async () => {
    const out = String(await getPlaceEvidenceTool(reader()).execute({ trip_id: SHORT, place: '1' }))
    expect(out).toContain('Akasaka Station')
    expect(out).toContain('confidence')
  })

  it('passes the resolver s ambiguity message through rather than guessing', async () => {
    const out = String(
      await getPlaceEvidenceTool(reader()).execute({ trip_id: SHORT, place: 'Tokyo' }),
    )
    expect(out).toContain('ambiguous')
  })

  it('needs a trip like the others', async () => {
    const out = String(await getPlaceEvidenceTool(reader()).execute({ place: '1' }))
    expect(out).toContain('Call list_trips')
  })
})

/**
 * The two source fields are different KINDS of evidence, and the tool used to print the wrong one.
 *
 * `backend-types.ts` splits them deliberately — `source_url` is "Independent research/venue page.
 * Deliberately NOT the Reel", `source_reel_url` is "The Instagram Reel this place was extracted
 * from" — and `backend/pipeline/persist.py::_evidence_json` writes exactly that split. The tool
 * printed `src: ${source_url}`, so it handed the agent a venue page while README.md:109,
 * docs/webmcp/SUBMISSION.md:60 and docs/webmcp/WHATS-NEW.md:35 all promise "its source Reel".
 * Evidence provenance is the one claim this entry is judged on, so these assert the LABELS as
 * much as the URLs: an agent that cannot tell the Reel from a venue page will cite the wrong one.
 */
describe('get_place_evidence — which source it hands back', () => {
  const REEL = 'https://www.instagram.com/reel/DYGH3jFBZHz/'
  const RESEARCH = 'https://www.example-venue.jp/access'

  /** One stop, with whatever evidence the case under test needs. */
  const bundleWith = (evidence: Partial<TripBundle['places'][number]['evidence_json']>): TripBundle => {
    const [first] = TOKYO_TRIP.places
    return {
      ...TOKYO_TRIP,
      places: [{ ...first, evidence_json: { ...first.evidence_json, ...evidence } }],
      // Two reels, so nothing can be attributed by "the trip has only one reel" either.
      inspiration: TOKYO_TRIP.inspiration,
    }
  }

  const evidenceFor = async (bundle: TripBundle): Promise<string> =>
    String(await getPlaceEvidenceTool(reader({ current: () => bundle })).execute({ place: '1' }))

  it('prints the source Reel, labelled as the Reel', async () => {
    const out = await evidenceFor(bundleWith({ source_reel_url: REEL, source_url: null }))
    expect(out).toContain(`reel: ${REEL}`)
  })

  it('never passes off the research page as the Reel', async () => {
    // The captured defect: `src: <research page>` was the ONLY source line, so an agent asked
    // "what reel is this from?" answered with a venue website.
    const out = await evidenceFor(bundleWith({ source_reel_url: REEL, source_url: RESEARCH }))
    expect(out).toContain(`reel: ${REEL}`)
    expect(out).toContain(`research: ${RESEARCH}`)
    expect(out).not.toContain(`reel: ${RESEARCH}`)
    expect(out).not.toContain('src:')
  })

  it('says so when the stop has no Reel behind it, rather than going quiet', async () => {
    // `source_reel_url` is optional in the type and absent on every row written before it
    // existed. Silence here reads to an agent as "the tool did not answer".
    const out = await evidenceFor(bundleWith({ source_reel_url: null, source_url: RESEARCH }))
    expect(out).toContain(`research: ${RESEARCH}`)
    expect(out).not.toContain('reel: ')
    expect(out).toMatch(/no source reel/i)
  })

  it('prints no link line at all when there is neither', async () => {
    const out = await evidenceFor(bundleWith({ source_reel_url: null, source_url: null }))
    // An empty `src: ` is worse than no line: it reads as a link that failed to load.
    expect(out).not.toMatch(/(reel|research|src):\s*$/m)
    expect(out).not.toContain('research:')
  })

  it('attributes nothing to a Reel on a stop the user typed', async () => {
    // Guardrail #1: an Instagram URL in a field is not provenance. `add_place` writes no reel.
    const bundle = bundleWith({ source_reel_url: REEL, evidence_kind: 'requested_by_you' })
    const typed: TripBundle = {
      ...bundle,
      places: [{ ...bundle.places[0], source_type: 'user_requested' }],
    }
    expect(await evidenceFor(typed)).not.toContain(REEL)
  })

  it('stays inside the output budget when both links are long', async () => {
    const long = `https://example.com/${'a'.repeat(300)}`
    const out = await evidenceFor(bundleWith({ source_reel_url: REEL, source_url: long }))
    expect(envelopeLength(out)).toBeLessThanOrEqual(OUTPUT_LIMIT)
  })

  it('hands a judge a REAL Reel URL on the sample trail', async () => {
    // The flagship demo is where this claim gets tested by someone who did not write it.
    const out = String(
      await getPlaceEvidenceTool(reader({ current: () => TOKYO_TRIP })).execute({ place: '1' }),
    )
    expect(out).toMatch(/reel: https:\/\/www\.instagram\.com\/reel\/[A-Za-z0-9_-]{5,}\//)
  })
})
