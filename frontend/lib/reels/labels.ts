import type { OrganizeItemStatus, SavedReelAnalysisStatus, SavedReelCard } from '@/lib/reels/backend-types'

/* Shared saved-reel label helpers. These idioms were replicated in LibraryPanel and ReelInfoCard
   (feasible-first, "no shared abstraction until a third caller" — ReelInfoCard finding N1). The
   browse grid (ReelBrowseGrid) is that third caller, so they are consolidated here.

   The status map covers the place-less states; a card WITH grounded places always reads
   "Places found · N" regardless of analysis_status (organized-but-zero still reads "· 0"). */

export const STATUS_LABELS: Record<SavedReelAnalysisStatus, string> = {
  not_analyzed: 'Not analyzed',
  queued: 'Queued',
  processing: 'Analyzing…',
  organized: 'Places found · 0',
  location_not_found: 'No places found',
  failed: 'Analysis failed',
}

/** Caption line: a grounded place count when present, else the analysis-status label. */
export function statusLabel(card: SavedReelCard): string {
  return card.places.length > 0 ? `Places found · ${card.places.length}` : STATUS_LABELS[card.analysis_status]
}

/** Display title for a saved reel: the user's label, else its caption, else a kind-aware
   fallback ("Untitled post" for a `/p/` card, "Untitled reel" otherwise). */
export function reelLabel(card: SavedReelCard): string {
  return (
    card.personal_label ??
    card.caption ??
    (sourceLabel(card.normalized_url) === 'Post' ? 'Untitled post' : 'Untitled reel')
  )
}

/** Level-1 URL-kind of a saved card: 'Post' for a photo/carousel `/p/<code>` URL, else 'Reel'.
   Derived from the URL at render time (zero schema change). The input is always a normalized
   canonical Instagram URL (`…/reel/<code>` or `…/p/<code>`, per parse-inspiration / the backend
   normalizer). Matches the `/p/<code>` path segment precisely — a leading slash + trailing
   code with no interior slash — so a reel shortcode that merely contains "p" never false-positives. */
export function sourceLabel(url: string): 'Reel' | 'Post' {
  return /\/p\/[^/]+\/?$/.test(url) ? 'Post' : 'Reel'
}

/** Distinct country names across a reel's grounded places as a compact "Japan +1" hint, or null. */
export function countryLabel(card: SavedReelCard): string | null {
  const names = Array.from(
    new Set(card.places.map((p) => p.country_name).filter((v): v is string => Boolean(v))),
  )
  if (names.length === 0) return null
  return names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`
}

/**
 * Show what an in-flight organize job is doing, WITHOUT persisting it.
 *
 * `saved_reels.analysis_status` is never 'queued' or 'processing' in practice — the organizer
 * writes only a terminal value at the end — so a card reads "Not analyzed" for an entire run.
 * Writing those two states into the row was the obvious fix and is the wrong one: nothing owns
 * them, `saved_reel_cards` HIDES a reel's places unless the status is 'organized', and
 * `authorize_place_ids` allows trip generation only from organized reels — so a re-analysis would
 * make verified places vanish and become unusable mid-run. The job's items already carry the
 * answer, so this projects them over the cards while the job is live and leaves nothing behind.
 */
export function overlayLiveStatus(
  cards: SavedReelCard[],
  liveItems: Record<string, OrganizeItemStatus>,
): SavedReelCard[] {
  if (Object.keys(liveItems).length === 0) return cards
  return cards.map((card) => {
    const item = liveItems[card.id]
    if (!item) return card

    /* The ROW WINS as soon as it has caught up, and `not_analyzed` with no places is precisely
       the state that proves it has not. Standing aside on the item's terminal status alone made
       a finished reel flip back to "Not analyzed" until the whole job ended and the cards were
       refetched — the first of two reels visibly regressed while the second was still running. */
    if (card.analysis_status !== 'not_analyzed' || card.places.length > 0) return card

    // Still stale. A terminal item here just means its refetch is in flight.
    return { ...card, analysis_status: item === 'queued' ? 'queued' : 'processing' }
  })
}
