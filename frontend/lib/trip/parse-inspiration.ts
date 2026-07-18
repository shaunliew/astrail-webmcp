import type {
  InspirationItemType, InspirationSource, InspirationStatus,
  BudgetLevel, GenerateTripRequest,
} from '@/lib/trip/backend-types'

export const MAX_REELS = 5
export const MAX_TRIP_PLACES = 8

export type DraftInspirationItem = {
  key: string // stable React key: the normalized URL (reels) or `place:<lowercased text>` (places)
  item_type: InspirationItemType
  source: InspirationSource
  normalized_reel_url: string | null
  requested_place_text: string | null
  status: InspirationStatus
}

export type BriefInput = {
  destination_hint: string
  start_date: string
  end_date: string
  origin_city: string
  budget_level: BudgetLevel | ''
  preferences: string
}

// Accepts reel / reels / p / tv, optionally under /share/, with or without scheme,
// on host instagram.com (or www./m. subdomains only), ignoring any query string or fragment.
// The leading (?:^|\/\/|\s) boundary anchors the host so a look-alike domain such as
// "notinstagram.com" or "instagram.com.evil.com" is rejected, not matched on substring.
// Canonical output: https://www.instagram.com/<type>/<code>/
const IG_RE = /(?:^|\/\/|\s)(?:www\.|m\.)?instagram\.com\/(?:share\/)?(reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i

export function normalizeReelUrl(raw: string): string | null {
  const m = raw.match(IG_RE)
  if (!m) return null
  const type = m[1].toLowerCase() === 'reels' ? 'reel' : m[1].toLowerCase()
  return `https://www.instagram.com/${type}/${m[2]}/`
}

function reelCount(items: DraftInspirationItem[]): number {
  return items.filter((i) => i.item_type === 'reel_url').length
}

export function buildReelItems(
  rawText: string,
  existing: DraftInspirationItem[],
): { items: DraftInspirationItem[]; addedCount: number; duplicateCount: number; invalidCount: number; overCapCount: number } {
  const seen = new Set(
    existing.filter((i) => i.item_type === 'reel_url').map((i) => i.normalized_reel_url),
  )
  const added: DraftInspirationItem[] = []
  let duplicateCount = 0, invalidCount = 0, overCapCount = 0

  for (const token of rawText.split(/\s+/).filter(Boolean)) {
    if (!/instagram\.com/i.test(token)) continue // prose — not a link
    const norm = normalizeReelUrl(token)
    if (!norm) { invalidCount++; continue }
    if (seen.has(norm)) { duplicateCount++; continue }
    if (reelCount(existing) + added.length >= MAX_REELS) { overCapCount++; continue }
    seen.add(norm)
    added.push({
      key: norm, item_type: 'reel_url', source: 'manual_paste',
      normalized_reel_url: norm, requested_place_text: null, status: 'valid',
    })
  }

  return { items: [...existing, ...added], addedCount: added.length, duplicateCount, invalidCount, overCapCount }
}

export function makeRequestedPlace(
  text: string,
  existing: DraftInspirationItem[],
): DraftInspirationItem | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const key = `place:${trimmed.toLowerCase()}`
  if (existing.some((i) => i.item_type === 'requested_place' && i.key === key)) return null
  return {
    key, item_type: 'requested_place', source: 'manual_input',
    normalized_reel_url: null, requested_place_text: trimmed, status: 'pending_resolution',
  }
}

export function canGenerate(items: DraftInspirationItem[], brief: BriefInput): boolean {
  // PRD §9 minimum (any reel or requested place) AND the pipeline's required date range.
  return items.length > 0 && brief.start_date.trim().length > 0 && brief.end_date.trim().length > 0
}

export function toGenerateRequest(items: DraftInspirationItem[], brief: BriefInput): GenerateTripRequest {
  const clean = (s: string): string | null => {
    const t = s.trim()
    return t.length ? t : null
  }
  return {
    reel_urls: items.filter((i) => i.item_type === 'reel_url' && i.normalized_reel_url).map((i) => i.normalized_reel_url as string),
    requested_places: items.filter((i) => i.item_type === 'requested_place' && i.requested_place_text).map((i) => i.requested_place_text as string),
    destination_hint: clean(brief.destination_hint),
    start_date: brief.start_date.trim(),
    end_date: brief.end_date.trim(),
    budget_level: brief.budget_level || null,
    origin_city: clean(brief.origin_city),
    preferences: clean(brief.preferences),
  }
}
