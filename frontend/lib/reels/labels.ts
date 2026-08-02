import type { SavedReelAnalysisStatus, SavedReelCard } from '@/lib/reels/backend-types'

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

/** Display title for a saved reel: the user's label, else its caption, else a fallback. */
export function reelLabel(card: SavedReelCard): string {
  return card.personal_label ?? card.caption ?? 'Untitled reel'
}

/** Distinct country names across a reel's grounded places as a compact "Japan +1" hint, or null. */
export function countryLabel(card: SavedReelCard): string | null {
  const names = Array.from(
    new Set(card.places.map((p) => p.country_name).filter((v): v is string => Boolean(v))),
  )
  if (names.length === 0) return null
  return names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`
}
