import { describe, it, expect } from 'vitest'
import { overlayLiveStatus, statusLabel } from '@/lib/reels/labels'
import type { OrganizeItemStatus, SavedReelCard } from '@/lib/reels/backend-types'

const card = (id: string, over: Partial<SavedReelCard> = {}): SavedReelCard => ({
  id, user_id: 'u1', normalized_url: `https://www.instagram.com/reel/${id}`,
  source_platform: 'instagram', reel_cache_id: null, has_current_cache: false,
  analysis_status: 'not_analyzed', personal_label: null, retry_after: null, analyzed_at: null,
  created_at: '2026-08-27T00:00:00Z', updated_at: '2026-08-27T00:00:00Z',
  caption: null, thumbnail_url: null, places: [], ...over,
})

describe('overlayLiveStatus', () => {
  it('turns a not-analyzed card into "Analyzing…" while its item is processing', () => {
    // The reported bug: the card read "Not analyzed" for the whole run, which is
    // indistinguishable from the save having silently failed.
    const [out] = overlayLiveStatus([card('a')], { a: 'processing' })
    expect(out.analysis_status).toBe('processing')
    expect(statusLabel(out)).toBe('Analyzing…')
  })

  it('shows a queued item as queued', () => {
    const [out] = overlayLiveStatus([card('a')], { a: 'queued' })
    expect(statusLabel(out)).toBe('Queued')
  })

  it('stands aside once the ROW has caught up, so the row wins', () => {
    for (const settled of ['organized', 'location_not_found', 'failed'] as OrganizeItemStatus[]) {
      const real = card('a', { analysis_status: 'organized' })
      expect(overlayLiveStatus([real], { a: settled })[0]).toBe(real)   // same object, untouched
    }
  })

  it('does NOT regress a finished reel to "Not analyzed" while its refetch is in flight', () => {
    /* The reported bug. In a two-reel job the first reel finished, its item went terminal, the
       overlay stood aside on that alone — and the card underneath was still the stale
       `not_analyzed` from the initial load, because the cards were only refetched when the whole
       JOB ended. So a completed reel visibly went backwards while the second was still running. */
    const stale = card('a', { analysis_status: 'not_analyzed', places: [] })
    const [out] = overlayLiveStatus([stale], { a: 'organized' })
    expect(statusLabel(out)).toBe('Analyzing…')
    expect(statusLabel(out)).not.toBe('Not analyzed')
  })

  it('lets a terminal row through the moment it carries places', () => {
    // The refetch landed: places prove the row is current even if a stale item says otherwise.
    const fresh = card('a', {
      analysis_status: 'not_analyzed',
      places: [{ place_id: 'p1', name: 'X', lat: 1, lng: 1, country_code: 'JP', country_name: 'Japan', evidence_quote: 'q', source_url: null, source_reel_url: 'u', confidence: 0.9 }],
    })
    expect(overlayLiveStatus([fresh], { a: 'processing' })[0]).toBe(fresh)
  })

  it('leaves cards the job does not mention completely alone', () => {
    const other = card('b')
    const out = overlayLiveStatus([card('a'), other], { a: 'processing' })
    expect(out[1]).toBe(other)
  })

  it('returns the very same array when no job is live', () => {
    // Identity matters: a new array every render would re-run every downstream memo for nothing.
    const cards = [card('a')]
    expect(overlayLiveStatus(cards, {})).toBe(cards)
  })

  it('never invents places — only the status is projected', () => {
    const withPlaces = card('a', { places: [{ place_id: 'p1', name: 'X', lat: 1, lng: 1, country_code: 'JP', country_name: 'Japan', evidence_quote: 'q', source_url: null, source_reel_url: 'u', confidence: 0.9 }] })
    const [out] = overlayLiveStatus([withPlaces], { a: 'processing' })
    expect(out.places).toBe(withPlaces.places)
    // A card WITH places reads "Places found · N" regardless of status, which stays true here.
    expect(statusLabel(out)).toBe('Places found · 1')
  })
})

describe('statusLabel: a used-up allowance is not a broken reel', () => {
  const AUG27 = Date.parse('2026-08-27T12:00:00Z')

  it('says when to come back instead of "Analysis failed"', () => {
    /* The organizer records a refused analysis as `failed` like any other error, so the card read
       "Analysis failed" — which says the reel cannot be analysed, when the truth is "not until
       tomorrow". Reported live: a reel that had succeeded an hour earlier showed as failed. */
    const capped = card('a', { analysis_status: 'failed', retry_after: '2026-08-28T00:00:00Z' })
    expect(statusLabel(capped, AUG27)).toContain('Daily limit reached')
    expect(statusLabel(capped, AUG27)).not.toBe('Analysis failed')
  })

  it('falls back to the plain label once the allowance has reset', () => {
    // The deadline passed, so the row is just stale — claiming a limit that no longer applies
    // would be its own wrong answer.
    const stale = card('a', { analysis_status: 'failed', retry_after: '2026-08-26T00:00:00Z' })
    expect(statusLabel(stale, AUG27)).toBe('Analysis failed')
  })

  it('keeps calling a REAL failure a failure', () => {
    // Every non-quota failure clears retry_after, so its absence is what marks a genuine error.
    const broken = card('a', { analysis_status: 'failed', retry_after: null })
    expect(statusLabel(broken, AUG27)).toBe('Analysis failed')
  })

  it('still prefers places over any status', () => {
    const found = card('a', {
      analysis_status: 'failed', retry_after: '2026-08-28T00:00:00Z',
      places: [{ place_id: 'p1', name: 'X', lat: 1, lng: 1, country_code: 'JP', country_name: 'Japan', evidence_quote: 'q', source_url: null, source_reel_url: 'u', confidence: 0.9 }],
    })
    expect(statusLabel(found, AUG27)).toBe('Places found · 1')
  })
})
