import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { thumbnailFor } from '@/components/map/popup-model'
import { recommendedHotelId } from '@/lib/trip/selectors'
import { TOKYO_TRIP } from '../tokyo-trip'

/**
 * The sample trail is the one page whose whole job is proving provenance, so its provenance is
 * checked here rather than trusted.
 *
 * `/app/trip/demo` is what a judge opens with no account and nothing spent, and the claim it
 * carries — README.md, docs/webmcp/SUBMISSION.md — is that every recommendation surfaces the
 * Reel it came from. It shipped with three invented codes (`/reel/AAA`, `/BBB`, `/CCC`) that 404
 * on Instagram, and quotes attributed to Reels that do not exist. A fixture cannot be reviewed
 * into honesty by eye; this asserts it against the captured scrape the backend eval runs on.
 *
 * The oracle is `backend/evals/fixtures/japan_demo_reels.json` — real Apify captures of the
 * frozen Case 1 demo set. Reading it across the frontend/backend line is deliberate: a copy of
 * the captions in this directory could drift from the real capture, and a check against a copy
 * of the thing it is checking proves nothing.
 */

type CapturedReel = { reel_url: string; caption: string | null; capture_status: string }

// Resolved from the working directory rather than import.meta.url, which vitest does not hand
// this file as a file: URL. Both spellings, so the suite runs from frontend/ or from the root.
const CAPTURE_CANDIDATES = ['../backend', 'backend']
  .map((base) => resolve(process.cwd(), base, 'evals/fixtures/japan_demo_reels.json'))

function capturedReels(): CapturedReel[] {
  const path = CAPTURE_CANDIDATES.find(existsSync)
  // Never skipped: a missing oracle means this check is not running, which is the state the
  // fixture was already in. Fail loudly and say where the file went.
  if (!path) {
    throw new Error(
      `Cannot verify the sample trail: none of ${CAPTURE_CANDIDATES.join(', ')} exists. It is the `
      + 'captured Apify scrape the demo Reel quotes are checked against. If it moved, fix this path.',
    )
  }
  const reels = (JSON.parse(readFileSync(path, 'utf8')) as { reels: CapturedReel[] }).reels
  expect(reels.length).toBeGreaterThan(0)
  return reels
}

const CAPTURED = capturedReels()
const captionFor = (url: string): string | null =>
  CAPTURED.find((r) => r.reel_url === url)?.caption ?? null

/** Every stop the fixture says came from a Reel, with the Reel it names. */
const reelSourced = TOKYO_TRIP.places
  .filter((tp) => tp.source_type === 'reel_extracted')
  .map((tp) => ({ name: tp.place.name, evidence: tp.evidence_json }))

describe('the sample trail cites Reels that exist', () => {
  it('has reel-sourced stops at all — the demo proves nothing without them', () => {
    expect(reelSourced.length).toBeGreaterThan(0)
  })

  it('names only Reels the repo has actually scraped', () => {
    // Anything outside the captured set is unverifiable from here, which is how AAA/BBB/CCC
    // survived review: they looked like URLs and nothing could tell they were not.
    for (const { name, evidence } of reelSourced) {
      expect(CAPTURED.map((r) => r.reel_url), `${name} cites an unscraped Reel`)
        .toContain(evidence.source_reel_url)
    }
  })

  it('quotes each Reel verbatim, as guardrail #1 requires of a real place', () => {
    for (const { name, evidence } of reelSourced) {
      const caption = captionFor(evidence.source_reel_url ?? '')
      expect(caption, `no captured caption for ${name}`).toBeTruthy()
      expect(evidence.quote, `${name} has no quote`).toBeTruthy()
      expect(caption!, `${name}'s quote is not in the caption of the Reel it cites`)
        .toContain(evidence.quote!)
    }
  })

  it('keeps the Reel out of source_url, which is reserved for a research page', () => {
    // backend-types.ts: source_url is "Independent research/venue page. Deliberately NOT the
    // Reel". get_place_evidence labels the two lines differently, so a Reel filed here is
    // handed to the agent as a venue page.
    for (const tp of TOKYO_TRIP.places) {
      expect(tp.evidence_json.source_url ?? '').not.toMatch(/instagram\.com/i)
    }
  })

  it('pastes the same Reels into the inspiration tray', () => {
    const urls = TOKYO_TRIP.inspiration
      .map((i) => i.normalized_reel_url)
      .filter((u): u is string => u !== null)
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) expect(CAPTURED.map((r) => r.reel_url)).toContain(url)
  })

  it('carries no placeholder Reel code anywhere', () => {
    // The regression guard proper: a fixture-shaped string that 404s is the defect, whatever
    // field it is sitting in.
    expect(JSON.stringify(TOKYO_TRIP)).not.toMatch(/instagram\.com\/reel\/[A-Z]{3}\//)
  })
})

describe('the sample trail is internally consistent', () => {
  it('dates each day inside the trip window', () => {
    const { start_date: start, end_date: end } = TOKYO_TRIP.trip
    for (const day of TOKYO_TRIP.days) {
      expect(day.day_date! >= start!, `day ${day.day_number} starts before the trip`).toBe(true)
      expect(day.day_date! <= end!, `day ${day.day_number} ends after the trip`).toBe(true)
    }
  })

  it('plans the trip before it happens', () => {
    // Not "after today" — that would make CI go red one morning with no code change. This is
    // the property that must hold forever; how near the window is stays a judgement call, and
    // it is stated where it is set.
    expect(TOKYO_TRIP.trip.start_date! > TOKYO_TRIP.trip.created_at.slice(0, 10)).toBe(true)
  })

  it('points every suggestion at a place the bundle actually holds', () => {
    const ids = new Set([
      ...TOKYO_TRIP.places.map((tp) => tp.place_id),
      ...TOKYO_TRIP.suggestion_places.map((p) => p.id),
    ])
    for (const r of TOKYO_TRIP.restaurants) {
      expect(ids, `${r.id} is anchored to a missing place`).toContain(r.near_place_id)
      expect(ids, `${r.id} suggests a missing place`).toContain(r.restaurant_place_id)
    }
  })
})

/**
 * The covers, which is where the provenance claim gets physical.
 *
 * `app/page.tsx` tells a visitor that every stop from a Reel "carries that Reel's own cover
 * frame", and `thumbnailFor` resolves a stop's cover through these inspiration rows. They held
 * `/landing/globe-japan.webp`, `/landing/coldopen-hero.webp` and `/landing/cta.webp` — Astrail's
 * OWN marketing art, served to a judge under a "From your Instagram Reel" label on the one page
 * whose argument is that nothing is presented as something it is not. Nothing was red, because
 * nothing checked.
 *
 * WHERE THE REAL ONES COME FROM. A scraped reel's cover is re-hosted out of Apify's expiring
 * `displayUrl` into the public `reel-covers` Storage bucket at `<short code>.jpg`
 * (`backend/pipeline/thumbnails.py`, keyed by `pipeline/cache.py::_cover_key`). Both demo Reels
 * were already cached, so the frames cost no Apify call and no quota slot to obtain.
 *
 * WHY THEY ARE COPIED IN rather than linked. A real trip reads its covers from Storage over the
 * network, but the sample trail is deliberately the one page that reaches no backend at all
 * (`app/app/trip/demo/page.tsx`), and a URL pointing out of the repo can rot — a dropped bucket,
 * a rotated project — with nothing here going red until a judge sees the broken image. A file
 * that ships in the deploy cannot, and the existence check below is what keeps it that way.
 */
describe('the sample trail shows the Reels own cover frames', () => {
  // Both spellings, for the same reason CAPTURE_CANDIDATES has two.
  const PUBLIC_CANDIDATES = ['public', 'frontend/public']
    .map((base) => resolve(process.cwd(), base))
  const publicRoot = PUBLIC_CANDIDATES.find(existsSync)

  const shortCode = (reelUrl: string) => reelUrl.replace(/\/+$/, '').split('/').pop()!
  const reelRows = TOKYO_TRIP.inspiration.filter((i) => i.normalized_reel_url !== null)

  it('has Reel rows to cover at all — the check proves nothing without them', () => {
    expect(reelRows.length).toBeGreaterThan(0)
  })

  it('names every cover for the Reel it belongs to, so a foreign image cannot sit there', () => {
    // The filename IS the provenance: `_cover_key` names a re-hosted frame by the Reel's own
    // short code, so a cover whose name matches the row's Reel came from that Reel by
    // construction. An arbitrary image path — marketing art, a stock photo — cannot satisfy this.
    for (const row of reelRows) {
      expect(row.thumbnail_url, `${row.id} shows no cover for the Reel it names`).toBeTruthy()
      expect(row.thumbnail_url).toBe(`/reel-covers/${shortCode(row.normalized_reel_url!)}.jpg`)
    }
  })

  it('ships every cover it points at, so the demo cannot degrade to a broken image', () => {
    expect(publicRoot, `no public/ dir in ${PUBLIC_CANDIDATES.join(', ')}`).toBeTruthy()
    for (const row of reelRows) {
      const file = resolve(publicRoot!, row.thumbnail_url!.replace(/^\//, ''))
      expect(existsSync(file), `${row.thumbnail_url} is not in the deploy`).toBe(true)
      // A real frame, not a zero-byte placeholder someone touched to make this pass.
      expect(readFileSync(file).byteLength).toBeGreaterThan(1024)
    }
  })

  it('resolves a cover for every stop the reader is told came from a Reel', () => {
    // The row-level checks above pass on a bundle where no stop reaches those rows. This walks
    // the reader's actual path — `thumbnailFor`, the function the pin and the itinerary card
    // both call — and ends at a file on disk.
    const fromReels = TOKYO_TRIP.places.filter((tp) => tp.source_type === 'reel_extracted')
    expect(fromReels.length).toBeGreaterThan(0)
    for (const tp of fromReels) {
      const cover = thumbnailFor(TOKYO_TRIP, tp)
      expect(cover, `${tp.place.name} is labelled "from a Reel" with no cover`).toBeTruthy()
      expect(existsSync(resolve(publicRoot!, cover!.replace(/^\//, '')))).toBe(true)
    }
  })

  it('leaves a non-Reel row uncovered, exactly as a real trip leaves it', () => {
    // `supabase-api.ts` fills thumbnail_url only from a saved reel card keyed by
    // normalized_reel_url, so a `requested_place` row is null on every real trip. It held
    // `/landing/cta.webp` — a shape the product cannot produce, dressing a typed request as
    // something pulled from Instagram.
    for (const row of TOKYO_TRIP.inspiration.filter((i) => i.normalized_reel_url === null)) {
      expect(row.thumbnail_url).toBeNull()
    }
  })

  it('borrows no landing-page artwork anywhere in the bundle', () => {
    // The regression guard proper, field-agnostic: the defect was the site's own hero images
    // being passed off as Reel frames, and it is the defect wherever it reappears.
    expect(JSON.stringify(TOKYO_TRIP)).not.toMatch(/\/landing\//)
  })
})

/**
 * The commercial-data boundary.
 *
 * The sample trail shipped a hotel it called "Shinjuku Granbell Hotel · USD 128/night · 4★",
 * attributed to Travala and backed by `travala_hotel_id: 'tv_12345'`. Hotel search is OFF
 * (`backend/pipeline/runner.py::HOTEL_SEARCH_ENABLED`), so no search produced any of it — an
 * invented booking id and an invented nightly price, presented to judges as a real suggestion on
 * a public page. It also made the demo the ONLY trip in the product where the hotel hub view
 * worked, so a judge who tried it here and then on their own trip got two answers.
 *
 * The rows still exist as test data in `tokyo-hotels.ts`, where nobody is shown them. This is the
 * boundary between the two: whatever that file holds must not leak back into what a route renders.
 */
describe('the sample trail invents no commercial data', () => {
  it('carries no hotel at all, which is what a trip generated today carries', () => {
    expect(TOKYO_TRIP.hotels).toEqual([])
    expect(recommendedHotelId(TOKYO_TRIP)).toBeNull()
  })

  it('quotes no price and no booking id anywhere in the bundle', () => {
    // Field-agnostic, because the price also reached the page through the tradeoff comparison's
    // `value: 'USD 128/night · 4★'` — a second surface, the same fabrication.
    const serialized = JSON.stringify(TOKYO_TRIP)
    expect(serialized).not.toMatch(/travala/i)
    expect(serialized).not.toMatch(/pricePerNight|totalPrice|price_snapshot":\s*\{[^}]/)
    expect(serialized).not.toMatch(/\bUSD\b/)
  })

  it('derives no hotel recommendation, because no search ran', () => {
    // The runner builds comparisons only `if HOTEL_SEARCH_ENABLED`: a price-vs-rating card is
    // advice, and stating it about a search that never happened is a conclusion about nothing.
    expect(TOKYO_TRIP.trip.tradeoffs.comparisons).toEqual([])
    // The pacing notes are independent of hotels and must survive — this is not "empty tradeoffs".
    expect(TOKYO_TRIP.trip.tradeoffs.notes.length).toBeGreaterThan(0)
  })

  it('claims no hotel work on the decision rail either', () => {
    // The disabled arm never constructs the hotel stage, so no hotel event reaches a real rail.
    // The demo's said "Skipped a hotel search near Disneyland (missing dates for that leg)" —
    // a reported outcome for work the pipeline cannot do.
    expect(TOKYO_TRIP.events.some((e) => e.stage === 'hotels')).toBe(false)
  })
})
