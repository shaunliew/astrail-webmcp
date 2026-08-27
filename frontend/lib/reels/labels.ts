import type { OrganizeItemStatus, SavedReel, SavedReelAnalysisStatus, SavedReelCard } from '@/lib/reels/backend-types'

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

/** Caption line: a grounded place count when present, else the analysis-status label.
 *
 *  `now` is injectable so the expiry branch is testable without freezing the clock globally.
 */
export function statusLabel(card: SavedReelCard, now: number = Date.now()): string {
  if (card.places.length > 0) return `Places found · ${card.places.length}`

  /* An allowance that resets is not a broken reel. The organizer records a refused analysis as
     `failed` like any other error, and the card then read "Analysis failed" — which says the reel
     cannot be analysed, when the truth is "not until tomorrow". `retry_after` is set only on that
     path (every other failure clears it), so its presence IS the distinction, and it is already
     carried to the browser. A past deadline falls through: the allowance has since reset, so the
     row is simply stale and the plain failure label is the honest one. */
  if (card.analysis_status === 'failed' && card.retry_after) {
    const resetsAt = Date.parse(card.retry_after)
    if (Number.isFinite(resetsAt) && resetsAt > now) {
      const when = new Date(resetsAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
      return `Daily limit reached · try again ${when}`
    }
  }
  return STATUS_LABELS[card.analysis_status]
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

    /* An ACTIVE item outranks whatever the row says, always. Yielding to any non-default row
       state was wrong in both directions: a reel being RE-analysed still carries its previous
       `failed`, `location_not_found` or `organized` outcome, so the row looked caught up while
       the new run was only starting, and the user watched a stale result sit there instead of
       "Analyzing…". The row's prior outcome is not evidence about the current job. */
    if (item === 'queued' || item === 'processing') {
      return { ...card, analysis_status: item }
    }

    /* The item is terminal. The row wins as soon as it has caught up — and `not_analyzed` with
       no places is precisely the state that proves it has NOT. Standing aside on the item's
       terminal status alone made a finished reel flip back to "Not analyzed" until the whole job
       ended: the first of two reels visibly regressed while the second was still running. */
    if (card.analysis_status !== 'not_analyzed' || card.places.length > 0) return card

    // Terminal item over a stale row: its refetch is in flight, so hold the working state.
    return { ...card, analysis_status: 'processing' }
  })
}

/**
 * The sentence under "No places found yet", where there is room for a reason.
 *
 * The card carries no error field — `saved_reel_cards` exposes status, `retry_after` and
 * `analyzed_at`, and nothing about what actually broke — so this says what the status MEANS and
 * what to do, and never invents a cause. A refused daily allowance is the one failure with a real
 * explanation attached, because `retry_after` records it.
 */
export function statusExplanation(card: SavedReelCard, now: number = Date.now()): string | null {
  switch (card.analysis_status) {
    case 'not_analyzed':
      return 'Organize it, from your library or its tray, to pull out its places.'
    case 'queued':
      return 'Waiting for a slot. This page updates itself as it goes.'
    case 'processing':
      return 'Reading the reel and checking each place against the map.'
    case 'location_not_found':
      return 'The reel was read, but nothing in it resolved to a real place on the map.'
    case 'failed': {
      const resetsAt = card.retry_after ? Date.parse(card.retry_after) : NaN
      if (Number.isFinite(resetsAt) && resetsAt > now) {
        return 'You have used today\u2019s analyses. Nothing is wrong with this reel \u2014 it can be analysed again after the limit resets.'
      }
      /* NOT "save it again": re-pasting only upserts the row, it does not re-run anything. What
         actually retries is organizing it — from the library, or the tray's own button. */
      return 'Something went wrong while reading it. Organize it again to retry.'
    }
    default:
      return null
  }
}

/**
 * Was this reel already in the library before this save?
 *
 * `capture_saved_reel` is an UPSERT and returns the row either way, so re-pasting a link a user
 * already has always reported "Saved to your library" — cheerfully telling them they did
 * something they did not.
 *
 * `updated_at !== created_at` is exact, and needs no clocks compared across machines: the table's
 * trigger is BEFORE UPDATE, so the conflict branch bumps `updated_at` while a fresh insert leaves
 * both set by the same `now()` in one statement. Any row that existed before is therefore either
 * touched by this upsert or already carries a later `updated_at` from its own analysis.
 */
export function wasAlreadySaved(reel: Pick<SavedReel, 'created_at' | 'updated_at'>): boolean {
  return reel.updated_at !== reel.created_at
}
