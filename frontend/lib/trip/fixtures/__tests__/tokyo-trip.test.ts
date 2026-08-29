import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
