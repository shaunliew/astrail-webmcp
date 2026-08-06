import { describe, it, expect } from 'vitest'
import {
  MAX_REELS, normalizeReelUrl, buildReelItems, makeRequestedPlace,
  canGenerate, toGenerateRequest,
  type DraftInspirationItem, type BriefInput,
} from '@/lib/trip/parse-inspiration'

const FULL_BRIEF: BriefInput = {
  destination_hint: '', start_date: '2026-08-01', end_date: '2026-08-04',
  origin_city: '', budget_level: '', preferences: '',
}

const EMPTY_BRIEF: BriefInput = {
  destination_hint: '', start_date: '', end_date: '',
  origin_city: '', budget_level: '', preferences: '',
}

describe('normalizeReelUrl', () => {
  it('canonicalizes reel/reels/p/tv forms to https reel URL, stripping query + fragment', () => {
    expect(normalizeReelUrl('https://www.instagram.com/reel/ABC123/')).toBe('https://www.instagram.com/reel/ABC123/')
    expect(normalizeReelUrl('instagram.com/reels/XYZ_9')).toBe('https://www.instagram.com/reel/XYZ_9/')
    expect(normalizeReelUrl('https://m.instagram.com/p/POST1/?igsh=abc#x')).toBe('https://www.instagram.com/p/POST1/')
    expect(normalizeReelUrl('https://www.instagram.com/share/reel/SH99/')).toBe('https://www.instagram.com/reel/SH99/')
  })

  it('collapses /tv/ (retired IGTV) into the /p/ post form, matching the backend _KIND', () => {
    expect(normalizeReelUrl('https://www.instagram.com/tv/TV123/')).toBe('https://www.instagram.com/p/TV123/')
    expect(normalizeReelUrl('instagram.com/tv/TVXYZ')).toBe('https://www.instagram.com/p/TVXYZ/')
  })

  it('keeps a /p/ post URL as /p/ (no cross-canonicalization into /reel/)', () => {
    expect(normalizeReelUrl('https://www.instagram.com/p/POST1/')).toBe('https://www.instagram.com/p/POST1/')
  })

  it('returns null for non-Instagram or malformed input', () => {
    expect(normalizeReelUrl('https://tiktok.com/@x/video/1')).toBeNull()
    expect(normalizeReelUrl('just some text')).toBeNull()
    expect(normalizeReelUrl('instagram.com/accounts/login')).toBeNull()
  })

  it('rejects look-alike domains that merely contain "instagram.com" as a substring', () => {
    expect(normalizeReelUrl('https://notinstagram.com/reel/ABC')).toBeNull()
    expect(normalizeReelUrl('https://instagram.com.evil.com/reel/ABC')).toBeNull()
    expect(normalizeReelUrl('xinstagram.com/reel/ABC')).toBeNull()
  })
})

describe('buildReelItems', () => {
  it('extracts + normalizes reel URLs from messy text and ignores prose', () => {
    const res = buildReelItems('omg check https://www.instagram.com/reel/AAA/ and https://instagram.com/reels/BBB please', [])
    expect(res.addedCount).toBe(2)
    expect(res.items.map((i) => i.normalized_reel_url)).toEqual([
      'https://www.instagram.com/reel/AAA/',
      'https://www.instagram.com/reel/BBB/',
    ])
    expect(res.items.every((i) => i.item_type === 'reel_url' && i.status === 'valid')).toBe(true)
  })

  it('deduplicates against existing items and within the batch', () => {
    const first = buildReelItems('https://www.instagram.com/reel/AAA/', [])
    const res = buildReelItems('https://www.instagram.com/reels/AAA/ https://www.instagram.com/reel/CCC/', first.items)
    expect(res.duplicateCount).toBe(1)
    expect(res.addedCount).toBe(1)
    expect(res.items.filter((i) => i.item_type === 'reel_url')).toHaveLength(2)
  })

  it('caps reels at MAX_REELS and reports the overflow', () => {
    const text = Array.from({ length: 7 }, (_, n) => `https://www.instagram.com/reel/R${n}/`).join('\n')
    const res = buildReelItems(text, [])
    expect(res.addedCount).toBe(MAX_REELS)
    expect(res.overCapCount).toBe(7 - MAX_REELS)
  })

  it('counts Instagram-looking tokens that fail to normalize as invalid', () => {
    const res = buildReelItems('https://www.instagram.com/accounts/login', [])
    expect(res.addedCount).toBe(0)
    expect(res.invalidCount).toBe(1)
  })

  it('deduplicates a /p/ post pasted twice within one batch', () => {
    const res = buildReelItems('https://www.instagram.com/p/DUP/ https://www.instagram.com/p/DUP/', [])
    expect(res.addedCount).toBe(1)
    expect(res.duplicateCount).toBe(1)
    expect(res.items.filter((i) => i.item_type === 'reel_url')).toHaveLength(1)
  })
})

describe('makeRequestedPlace', () => {
  it('creates a requested_place item keeping verbatim text', () => {
    const item = makeRequestedPlace('  Tokyo Disneyland ', [])
    expect(item).not.toBeNull()
    expect(item!.item_type).toBe('requested_place')
    expect(item!.requested_place_text).toBe('Tokyo Disneyland')
    expect(item!.status).toBe('pending_resolution')
  })

  it('returns null for blank text or a case-insensitive duplicate', () => {
    const first = makeRequestedPlace('Shibuya', [])!
    expect(makeRequestedPlace('   ', [])).toBeNull()
    expect(makeRequestedPlace('shibuya', [first])).toBeNull()
  })
})

describe('canGenerate', () => {
  it('is true with at least one reel or place AND both dates', () => {
    expect(canGenerate([], FULL_BRIEF)).toBe(false)
    expect(canGenerate([makeRequestedPlace('Kyoto', [])!], FULL_BRIEF)).toBe(true)
    expect(canGenerate(buildReelItems('https://www.instagram.com/reel/AAA/', []).items, FULL_BRIEF)).toBe(true)
  })
  it('is false when either date is missing', () => {
    const items = [makeRequestedPlace('Kyoto', [])!]
    expect(canGenerate(items, { ...FULL_BRIEF, start_date: '' })).toBe(false)
    expect(canGenerate(items, { ...FULL_BRIEF, end_date: '  ' })).toBe(false)
  })
})

describe('toGenerateRequest', () => {
  it('splits items into reel_urls + requested_places and nulls empty brief fields', () => {
    const items: DraftInspirationItem[] = [
      ...buildReelItems('https://www.instagram.com/reel/AAA/', []).items,
      makeRequestedPlace('Tokyo Disneyland', [])!,
    ]
    const req = toGenerateRequest(items, { ...EMPTY_BRIEF, destination_hint: 'Tokyo', budget_level: 'mid_range', start_date: '2026-08-01', end_date: '2026-08-04' })
    expect(req.reel_urls).toEqual(['https://www.instagram.com/reel/AAA/'])
    expect(req.requested_places).toEqual(['Tokyo Disneyland'])
    expect(req.destination_hint).toBe('Tokyo')
    expect(req.budget_level).toBe('mid_range')
    expect(req.start_date).toBe('2026-08-01')
    expect(req.origin_city).toBeNull()
    expect(req.preferences).toBeNull()
  })
})

describe('toGenerateRequest dates', () => {
  it('emits trimmed non-null dates', () => {
    const req = toGenerateRequest([], { ...FULL_BRIEF, start_date: ' 2026-08-01 ' })
    expect(req.start_date).toBe('2026-08-01')
    expect(req.end_date).toBe('2026-08-04')
  })
})
