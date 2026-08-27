// lib/trip/__tests__/supabase-api-covers.test.ts
//
// The map pin's Reel cover is EVIDENCE, and it is the one field in TripBundle that no table in
// the trip query actually contains. `thumbnail_url` lives on `reel_cache`; `trip_inspiration_items`
// carries only `reel_cache_id`. Worse, `reel_cache` is REVOKED from `authenticated` (migration
// 20260718130000), so a client-side PostgREST embed is denied rather than empty — it fails in a
// way that looks identical to "this Reel has no cover".
//
// The fixture hand-injects `thumbnail_url`, so every popup/pin test passes against data the live
// loader could never produce. These tests exercise the LOADER against realistic PostgREST row
// shapes, which is the only place the gap was visible.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/client', () => ({ createClient }))
vi.mock('@/lib/auth/mock-auth', () => ({ MOCK_AUTH_ENABLED: false, MOCK_USER: {}, getMockSession: () => null }))
vi.mock('@/lib/backend-url', () => ({ resolveBackendUrl: () => 'http://backend.test' }))

const TRIP_ID = 'trip-1'
// The STORED form, verified against live rows: backend/scrape/reel_url.py normalises to
// `.../reel/ABC` with NO trailing slash, and that is what `saved_reels.normalized_url` holds.
// lib/trip/parse-inspiration.ts normalises the same URL WITH a trailing slash, so matching the
// frontend form against the stored one finds nothing — silently. Stored form is canonical here.
const REEL_A = 'https://www.instagram.com/reel/AAA'
const REEL_B = 'https://www.instagram.com/reel/BBB'

/** Rows keyed by table, exactly as PostgREST would return them — note that
 *  `trip_inspiration_items` has NO thumbnail_url column, because the table has none. */
function stubSupabase(tables: Record<string, unknown[]>, spy?: { savedReelQuery?: unknown[] }) {
  return {
    from(table: string) {
      const rows = tables[table] ?? []
      // Every builder method returns the builder; the builder is thenable, so both
      // `await q` and `await q.maybeSingle()` resolve. Mirrors the fluent PostgREST client.
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        in: (_col: string, values: unknown[]) => {
          if (table === 'saved_reel_cards' && spy) spy.savedReelQuery = values
          return builder
        },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (v: { data: unknown[], error: null }) => unknown) =>
          resolve({ data: rows, error: null }),
      }
      return builder
    },
  }
}

const inspirationRow = (url: string | null, id: string) => ({
  id, trip_id: TRIP_ID, item_type: 'reel_url', source: 'manual_paste',
  normalized_reel_url: url, reel_cache_id: url ? `rc_${id}` : null,
  requested_place_text: null, resolved_place_id: null, status: 'valid',
  // deliberately NO thumbnail_url — the real table does not have this column
})

const tripPlace = (placeId: string, sourceType: string, sourceReelUrl: string | null = null) => ({
  id: `tp_${placeId}`, trip_id: TRIP_ID, place_id: placeId, source_type: sourceType,
  day_number: 1, sort_order: 0,
  evidence_json: {
    confidence: 0.9, source_url: 'https://map.yahoo.co.jp/v3/place/XYZ', quote: 'q', quotes: ['q'],
    rationale: null, evidence_kind: sourceType === 'reel_extracted' ? 'reel_quote' : 'requested_by_you',
    ...(sourceReelUrl ? { source_reel_url: sourceReelUrl } : {}),
  },
  place: { id: placeId, name: placeId, lat: 1, lng: 1 },
})

const mention = (placeId: string, reelUrl: string) => ({ place_id: placeId, source_reel_url: reelUrl })

async function loadTrip(tables: Record<string, unknown[]>, spy?: { savedReelQuery?: unknown[] }) {
  createClient.mockReturnValue(stubSupabase({ trips: [{ id: TRIP_ID }], ...tables }, spy))
  const { getTrip } = await import('@/lib/trip/supabase-api')
  return getTrip(TRIP_ID)
}

describe('getTrip: Reel covers', () => {
  beforeEach(() => {
    vi.resetModules()
    createClient.mockReset()
  })

  it('resolves each cover through saved_reel_cards, which joins reel_cache server-side', async () => {
    const spy: { savedReelQuery?: unknown[] } = {}
    const bundle = await loadTrip({
      trip_inspiration_items: [inspirationRow(REEL_A, 'i1'), inspirationRow(REEL_B, 'i2')],
      saved_reel_cards: [
        { normalized_url: REEL_A, thumbnail_url: 'https://cdn.test/a.jpg' },
        { normalized_url: REEL_B, thumbnail_url: 'https://cdn.test/b.jpg' },
      ],
    }, spy)

    expect(bundle!.inspiration.map((i) => i.thumbnail_url))
      .toEqual(['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg'])
    // Scoped to this trip's Reels, not a full-table read.
    expect(spy.savedReelQuery).toEqual([REEL_A, REEL_B])
  })

  it('falls back to no cover when the Reel is no longer among the user saved Reels', async () => {
    // saved_reel_cards is user-scoped; a Reel the user removed simply is not there. The pin
    // must then show the universal placeholder rather than any substitute image.
    const bundle = await loadTrip({
      trip_inspiration_items: [inspirationRow(REEL_A, 'i1')],
      saved_reel_cards: [],
    })
    expect(bundle!.inspiration[0].thumbnail_url).toBeNull()
  })

  it('normalises a missing cover to null rather than undefined', async () => {
    // `thumbnailFor` returns `?? null`, but a bundle carrying `undefined` would serialise
    // differently and read as "field absent" to anything inspecting the shape.
    const bundle = await loadTrip({
      trip_inspiration_items: [inspirationRow(REEL_A, 'i1')],
      saved_reel_cards: [{ normalized_url: REEL_A, thumbnail_url: null }],
    })
    expect(bundle!.inspiration[0].thumbnail_url).toBeNull()
    expect('thumbnail_url' in bundle!.inspiration[0]).toBe(true)
  })

  it('skips the lookup entirely for a trip with no Reels', async () => {
    // A requested-place-only trip must not issue a pointless `in ()` query.
    const spy: { savedReelQuery?: unknown[] } = {}
    const bundle = await loadTrip({
      trip_inspiration_items: [inspirationRow(null, 'i1')],
      saved_reel_cards: [],
    }, spy)
    expect(spy.savedReelQuery).toBeUndefined()
    expect(bundle!.inspiration[0].thumbnail_url).toBeNull()
  })

  it('asks for each distinct Reel once when several stops share it', async () => {
    const spy: { savedReelQuery?: unknown[] } = {}
    await loadTrip({
      trip_inspiration_items: [inspirationRow(REEL_A, 'i1'), inspirationRow(REEL_A, 'i2')],
      saved_reel_cards: [{ normalized_url: REEL_A, thumbnail_url: 'https://cdn.test/a.jpg' }],
    }, spy)
    expect(spy.savedReelQuery).toEqual([REEL_A])
  })
})

describe('getTrip: Reel attribution for rows written before source_reel_url existed', () => {
  beforeEach(() => {
    vi.resetModules()
    createClient.mockReset()
  })

  // The reported bug: a stop's popup said "From your Instagram Reel" but the only link was a
  // Yahoo Maps page, because `source_url` is the RESEARCH page and the Reel was never recorded.
  // reelUrlFor's legacy fallback cannot rescue it — that needs a single-Reel trip, and this is a
  // multi-Reel one. reel_place_mentions recorded which Reel named which place all along.
  it('recovers the Reel for a legacy stop from reel_place_mentions', async () => {
    const bundle = await loadTrip({
      trip_inspiration_items: [inspirationRow(REEL_A, 'i1'), inspirationRow(REEL_B, 'i2')],
      trip_places: [tripPlace('pl_dekasan', 'reel_extracted')],
      saved_reel_cards: [
        { normalized_url: REEL_A, thumbnail_url: null, places: [mention('pl_dekasan', REEL_A)] },
        { normalized_url: REEL_B, thumbnail_url: null, places: [] },
      ],
    })
    expect(bundle!.places[0].evidence_json.source_reel_url).toBe(REEL_A)
  })

  it('never overwrites an attribution the backend already recorded', async () => {
    const bundle = await loadTrip({
      trip_inspiration_items: [inspirationRow(REEL_A, 'i1')],
      trip_places: [tripPlace('pl_x', 'reel_extracted', REEL_B)],
      saved_reel_cards: [{ normalized_url: REEL_A, thumbnail_url: null, places: [mention('pl_x', REEL_A)] }],
    })
    expect(bundle!.places[0].evidence_json.source_reel_url).toBe(REEL_B)
  })

  it('does not attribute a Reel to a stop the user asked for', async () => {
    // A Reel can mention a place the user also typed. Backfilling it would let the popup claim
    // the stop came from that Reel — a false provenance claim (guardrail #1).
    const bundle = await loadTrip({
      trip_inspiration_items: [inspirationRow(REEL_A, 'i1')],
      trip_places: [tripPlace('pl_typed', 'user_requested')],
      saved_reel_cards: [{ normalized_url: REEL_A, thumbnail_url: null, places: [mention('pl_typed', REEL_A)] }],
    })
    expect(bundle!.places[0].evidence_json.source_reel_url).toBeUndefined()
  })

  it('leaves a stop unattributed when no Reel mentions it', async () => {
    const bundle = await loadTrip({
      trip_inspiration_items: [inspirationRow(REEL_A, 'i1')],
      trip_places: [tripPlace('pl_orphan', 'reel_extracted')],
      saved_reel_cards: [{ normalized_url: REEL_A, thumbnail_url: null, places: [] }],
    })
    expect(bundle!.places[0].evidence_json.source_reel_url).toBeNull()
  })
})

// ⚠ THE CASE THAT ACTUALLY HAPPENS IN PRODUCTION.
//
// `trip_inspiration_items` has no producer — nothing writes it, which
// components/trip/OrchestratorSummary.tsx documents in place. So on every real trip that table
// is EMPTY, and every consumer keyed off it (pin covers, popup Reel attribution, reelUrlFor's
// single-Reel fallback) was inert in production while passing its fixture tests, because the
// Tokyo fixture hand-writes rows the live table never receives. The tests above use the same
// hand-written shape and therefore could not see it either.
//
// The durable record is the `create_trip` generation event, which carries the URLs as pasted.
describe('getTrip: recovering the trip Reels when trip_inspiration_items is empty', () => {
  beforeEach(() => {
    vi.resetModules()
    createClient.mockReset()
  })

  const createTripEvent = (reelUrls: unknown) => ({
    id: 'ev1', trip_id: TRIP_ID, event_type: 'stage', stage: 'create_trip',
    message: 'Starting your trip', payload: { reel_urls: reelUrls }, created_at: '2026-08-01T00:00:00Z',
  })

  it('reads the Reels from the create_trip event and resolves covers from them', async () => {
    const spy: { savedReelQuery?: unknown[] } = {}
    const bundle = await loadTrip({
      trip_inspiration_items: [],                       // the real production state
      generation_events: [createTripEvent([REEL_A, REEL_B])],
      saved_reel_cards: [
        { normalized_url: REEL_A, thumbnail_url: 'https://cdn.test/a.jpg', places: [] },
        { normalized_url: REEL_B, thumbnail_url: 'https://cdn.test/b.jpg', places: [] },
      ],
    }, spy)

    expect(spy.savedReelQuery).toEqual([REEL_A, REEL_B])
    expect(bundle!.inspiration.map((i) => i.thumbnail_url))
      .toEqual(['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg'])
  })

  it('normalises the pasted URLs so they can match saved_reels', async () => {
    // The event stores `req.reel_urls` exactly as the user pasted them — share links carry
    // tracking params and the host varies. `saved_reels.normalized_url` is canonical, so an
    // unnormalised `in()` would match nothing and silently yield no covers.
    const spy: { savedReelQuery?: unknown[] } = {}
    await loadTrip({
      trip_inspiration_items: [],
      generation_events: [createTripEvent([
        'https://instagram.com/reel/AAA/?igsh=tracking',
        'https://www.instagram.com/reels/BBB',
      ])],
      saved_reel_cards: [],
    }, spy)
    expect(spy.savedReelQuery).toEqual([REEL_A, REEL_B])
  })

  it('also recovers per-place attribution, which is what puts the Reel link in the popup', async () => {
    const bundle = await loadTrip({
      trip_inspiration_items: [],
      generation_events: [createTripEvent([REEL_A])],
      trip_places: [tripPlace('pl_dekasan', 'reel_extracted')],
      saved_reel_cards: [
        { normalized_url: REEL_A, thumbnail_url: null, places: [mention('pl_dekasan', REEL_A)] },
      ],
    })
    expect(bundle!.places[0].evidence_json.source_reel_url).toBe(REEL_A)
  })

  it('lets the table define the trip Reels, while still looking up both sources', async () => {
    // Two different behaviours, deliberately. The LOOKUP asks for the union — one extra card is
    // cheap, and a trip whose table rows and event payload disagree should not lose a cover over
    // it. What is PRESENTED as the trip's inspiration still comes from the table when it has
    // rows, so a real producer (once one exists) always outranks anything reconstructed here.
    const spy: { savedReelQuery?: unknown[] } = {}
    const bundle = await loadTrip({
      trip_inspiration_items: [inspirationRow(REEL_A, 'i1')],
      generation_events: [createTripEvent([REEL_B])],
      saved_reel_cards: [],
    }, spy)
    expect(spy.savedReelQuery).toEqual([REEL_A, REEL_B])
    expect(bundle!.inspiration.map((i) => i.normalized_reel_url)).toEqual([REEL_A])
  })

  it('survives a trip with no create_trip event and a malformed payload', async () => {
    // Older trips, or a payload shape that drifted. Must degrade to "no Reels", never throw:
    // a crash here takes down the whole trip page, not just the covers.
    for (const events of [[], [createTripEvent(null)], [createTripEvent('not-an-array')], [createTripEvent([42, null])]]) {
      const spy: { savedReelQuery?: unknown[] } = {}
      const bundle = await loadTrip({
        trip_inspiration_items: [], generation_events: events, saved_reel_cards: [],
      }, spy)
      expect(spy.savedReelQuery).toBeUndefined()
      expect(bundle!.inspiration).toEqual([])
    }
  })
})

// ⚠ THE REPORTED CASE, reproduced from live rows.
//
// A trip built from the Library — pick places out of already-organized Reels — records
// `reel_urls: []` and `place_ids: [...]` in its create_trip event, because
// backend/api/schemas.py accepts one or the other and rejects both together. So the trip names
// NO Reels at all, `trip_inspiration_items` is empty as always, and every trip-level lookup
// finds nothing. The stop still renders "From your Instagram Reel" over a verbatim quote,
// because its evidence_kind IS reel_quote — but the only link was the research page.
//
// The attribution was never missing. It is per PLACE, in reel_place_mentions.
describe('getTrip: a trip built from place_ids, which names no Reels', () => {
  beforeEach(() => {
    vi.resetModules()
    createClient.mockReset()
  })

  const libraryTripEvent = {
    id: 'ev1', trip_id: TRIP_ID, event_type: 'stage', stage: 'create_trip',
    message: 'Starting your trip',
    payload: { reel_urls: [], place_ids: ['pl_umeda'], requested_places: [] },
    created_at: '2026-08-01T00:00:00Z',
  }

  it('attributes each stop through reel_place_mentions and gives the pin its cover', async () => {
    const spy: { savedReelQuery?: unknown[] } = {}
    const bundle = await loadTrip({
      trip_inspiration_items: [],
      generation_events: [libraryTripEvent],
      trip_places: [tripPlace('pl_umeda', 'reel_extracted')],
      saved_reel_cards: [
        { normalized_url: REEL_A, thumbnail_url: 'https://cdn.test/a.jpg', places: [mention('pl_umeda', REEL_A)] },
        // Another of the owner's Reels, describing a place on a DIFFERENT trip.
        { normalized_url: REEL_B, thumbnail_url: 'https://cdn.test/b.jpg', places: [mention('pl_elsewhere', REEL_B)] },
      ],
    }, spy)

    // No declared Reels, so the owner's saved Reels are read unfiltered rather than `in ([])`,
    // which would have matched nothing — the bug that made this trip unfixable.
    expect(spy.savedReelQuery).toBeUndefined()
    expect(bundle!.places[0].evidence_json.source_reel_url).toBe(REEL_A)
    // Only the Reel that actually placed a stop on THIS trip becomes its inspiration...
    expect(bundle!.inspiration.map((i) => i.normalized_reel_url)).toEqual([REEL_A])
    // ...and it carries the cover, so the pin stops falling back to the placeholder.
    expect(bundle!.inspiration[0].thumbnail_url).toBe('https://cdn.test/a.jpg')
  })

  it('does not borrow a Reel that only describes another trip\'s places', async () => {
    const bundle = await loadTrip({
      trip_inspiration_items: [],
      generation_events: [libraryTripEvent],
      trip_places: [tripPlace('pl_umeda', 'reel_extracted')],
      saved_reel_cards: [
        { normalized_url: REEL_B, thumbnail_url: 'https://cdn.test/b.jpg', places: [mention('pl_elsewhere', REEL_B)] },
      ],
    })
    expect(bundle!.places[0].evidence_json.source_reel_url).toBeNull()
    expect(bundle!.inspiration).toEqual([])
  })

  it('matches the stored URL form, not the frontend-normalised one', async () => {
    // backend/scrape/reel_url.py stores `.../reel/ABC`; lib/trip/parse-inspiration.ts produces
    // `.../reel/ABC/`. Comparing the two forms finds nothing, and nothing errors — the pin just
    // stays a placeholder forever.
    const bundle = await loadTrip({
      trip_inspiration_items: [],
      generation_events: [{ ...libraryTripEvent, payload: { reel_urls: [`${REEL_A}/`] } }],
      trip_places: [tripPlace('pl_umeda', 'reel_extracted')],
      saved_reel_cards: [
        { normalized_url: REEL_A, thumbnail_url: 'https://cdn.test/a.jpg', places: [mention('pl_umeda', REEL_A)] },
      ],
    })
    expect(bundle!.places[0].evidence_json.source_reel_url).toBe(REEL_A)
    expect(bundle!.inspiration[0].thumbnail_url).toBe('https://cdn.test/a.jpg')
  })
})
