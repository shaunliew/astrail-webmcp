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
const REEL_A = 'https://www.instagram.com/reel/AAA/'
const REEL_B = 'https://www.instagram.com/reel/BBB/'

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
