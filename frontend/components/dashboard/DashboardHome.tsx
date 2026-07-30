'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { listTrips } from '@/lib/trip/supabase-api'
import type { SavedReelCard, SavedReelAnalysisStatus } from '@/lib/reels/backend-types'
import type { Trip, TripStatus } from '@/lib/trip/backend-types'
import FolderGallery, { type FolderPhoto } from '@/components/ui/folder-gallery'

/* The paper dashboard home. Replaces the old dark inbox: greeting + quick-capture +
   Saved Reels (with filter chips + select-to-plan) + Your trails grid + empty state.
   Reuses SavedReelsFlow's capture/organize handlers; fetches trips itself.

   NOTE: the mockup's category chips (Attractions/Food/Shops) need places[].place_type,
   which the saved_reel_cards view does not carry — so chips filter on analysis_status
   instead (Places found / Processing / Not resolved). Trail cards show destination +
   dates + status; place/day counts and the constellation thumbnail need per-trip place
   fetches (deferred), so the media is a neutral placeholder — no invented geometry. */

const MAX_SELECTED = 5

const BTN_PRIMARY =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[color:var(--accent)] bg-[color:var(--accent)] px-4 text-[13px] font-medium text-[color:var(--accent-text)] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]'
const BTN_SECONDARY =
  'inline-flex min-h-11 items-center justify-center rounded-lg border border-[color:var(--paper-line-2)] bg-transparent px-4 text-[13px] font-medium text-[color:var(--text)] transition-colors hover:bg-[color:var(--surface-2)] disabled:cursor-default disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]'

function reelStatusLabel(card: SavedReelCard): string {
  switch (card.analysis_status) {
    case 'organized': return `Places found · ${card.places.length}`
    case 'processing': return 'Processing'
    case 'queued': return 'Queued'
    case 'not_analyzed': return 'Not analyzed'
    case 'location_not_found': return 'No location found'
    case 'failed': return 'Couldn’t read'
    default: return ''
  }
}

type ReelFilter = 'all' | 'found' | 'processing' | 'unresolved'
function reelBucket(status: SavedReelAnalysisStatus): Exclude<ReelFilter, 'all'> {
  if (status === 'organized') return 'found'
  if (status === 'queued' || status === 'processing') return 'processing'
  return 'unresolved'
}
const REEL_FILTERS: { key: ReelFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'found', label: 'Places found' },
  { key: 'processing', label: 'Processing' },
  { key: 'unresolved', label: 'Not resolved' },
]

const TRIP_BADGE: Record<TripStatus, string> = {
  draft: 'Draft',
  generating: 'Generating',
  places_ready: 'Places ready',
  complete: 'Complete',
  saved_with_gaps: 'Saved with gaps',
  failed: 'Couldn’t finish',
}
type TrailFilter = 'all' | 'progress' | 'ready'
function trailBucket(status: TripStatus): 'progress' | 'ready' | 'other' {
  if (status === 'draft' || status === 'generating' || status === 'places_ready') return 'progress'
  if (status === 'complete' || status === 'saved_with_gaps') return 'ready'
  return 'other'
}
const TRAIL_FILTERS: { key: TrailFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'progress', label: 'In progress' },
  { key: 'ready', label: 'Ready' },
]

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
function tripMeta(trip: Trip): string {
  const dest = trip.inferred_destination ?? trip.destination_hint ?? 'Destination TBD'
  const dates = trip.start_date ? (trip.end_date ? `${fmtDay(trip.start_date)} – ${fmtDay(trip.end_date)}` : fmtDay(trip.start_date)) : 'No dates'
  return `${dest} · ${dates}`
}

export default function DashboardHome({
  cards,
  onCapture,
  onOrganize,
}: {
  cards: SavedReelCard[]
  onCapture: (url: string) => Promise<void>
  onOrganize: (ids: string[]) => Promise<void>
}) {
  const [name, setName] = useState('traveler')
  const [trips, setTrips] = useState<Trip[]>([])
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [reelFilter, setReelFilter] = useState<ReelFilter>('all')
  const [trailFilter, setTrailFilter] = useState<TrailFilter>('all')
  const activeRef = useRef(true)

  useEffect(() => {
    activeRef.current = true
    createClient()
      .auth.getUser()
      .then(({ data }) => {
        if (!activeRef.current) return
        const meta = data.user?.user_metadata as { full_name?: string; name?: string } | undefined
        const fallback = data.user?.email?.split('@')[0]
        setName(meta?.full_name ?? meta?.name ?? fallback ?? 'traveler')
      })
      .catch(() => {})
    listTrips()
      .then((next) => { if (activeRef.current) setTrips(next) })
      .catch(() => { /* home stays usable without the trails grid */ })
    return () => { activeRef.current = false }
  }, [])

  const reelCounts = useMemo(() => {
    const c = { all: cards.length, found: 0, processing: 0, unresolved: 0 }
    for (const card of cards) c[reelBucket(card.analysis_status)] += 1
    return c
  }, [cards])

  const visibleCards = reelFilter === 'all' ? cards : cards.filter((card) => reelBucket(card.analysis_status) === reelFilter)
  const visibleTrips = trailFilter === 'all' ? trips : trips.filter((trip) => trailBucket(trip.status) === trailFilter)

  // The reel wallet fans a handful of thumbnails; cap so a large inbox stays legible.
  // Per-trail folders await a per-trip place/thumbnail fetch (see file-top NOTE) — for now
  // this is one folder over the whole saved-Reel set, the collection concept not yet split.
  const folderPhotos = useMemo<FolderPhoto[]>(
    () => cards.slice(0, 8).map((card) => ({
      id: card.id,
      image: card.thumbnail_url,
      alt: card.personal_label ?? card.caption ?? '',
    })),
    [cards],
  )

  async function capture() {
    if (!url.trim()) return
    setBusy(true); setMessage(null)
    try {
      await onCapture(url.trim())
      if (!activeRef.current) return
      setUrl(''); setMessage('Saved to your inbox.')
    } catch (error) {
      if (activeRef.current) setMessage(error instanceof Error ? error.message : 'Could not save that Reel.')
    } finally {
      if (activeRef.current) setBusy(false)
    }
  }

  function toggleSelect(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((v) => v !== id) : current.length < MAX_SELECTED ? [...current, id] : current,
    )
  }

  async function organize() {
    if (!selected.length) return
    setBusy(true); setMessage(null)
    try {
      await onOrganize(selected)
    } catch (error) {
      if (activeRef.current) { setMessage(error instanceof Error ? error.message : 'Could not organize those Reels.'); setBusy(false) }
    }
  }

  const isEmpty = cards.length === 0 && trips.length === 0

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col">
      <header className="mb-8 flex items-start justify-between gap-5">
        <div>
          <p className="text-[13px] text-[color:var(--text-muted)]">Welcome back,</p>
          <span
            className="mt-1 block font-display text-[28px] font-medium leading-tight tracking-[-0.01em] text-[color:var(--text)]"
            style={{ fontVariationSettings: "'SOFT' 28, 'WONK' 0, 'opsz' 28" }}
          >
            {name}
          </span>
        </div>
        {!isEmpty ? (
          <button type="button" className={BTN_PRIMARY} onClick={() => setSelectionMode(true)}>
            Create trip
          </button>
        ) : null}
      </header>

      {/* Quick capture — always available */}
      <form
        onSubmit={(e) => { e.preventDefault(); void capture() }}
        className="mb-9 flex items-center gap-3 rounded-2xl border border-dashed border-[color:var(--line-soft)] bg-[color:var(--surface-2)] p-3"
      >
        <label htmlFor="capture-input" className="sr-only">Paste a Reel link</label>
        <input
          id="capture-input"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste an Instagram Reel link to save it for later…"
          className="min-h-11 flex-1 rounded-lg border border-[color:var(--line-soft)] bg-[color:var(--surface-1)] px-4 text-[color:var(--text)] placeholder:text-[color:var(--text-faint)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]"
        />
        <button type="submit" disabled={busy || !url.trim()} className={BTN_PRIMARY}>Save</button>
      </form>
      {message ? <p role="status" className="-mt-6 mb-6 text-[13px] text-[color:var(--text-muted)]">{message}</p> : null}

      {isEmpty ? (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-[color:var(--line-soft)] px-6 py-16 text-center">
          <span aria-hidden className="h-[72px] w-[72px] rounded-full border border-dashed border-[color:var(--line-soft)]" />
          <h2 className="font-display text-[18px] font-medium text-[color:var(--text)]">No trails yet</h2>
          <p className="max-w-[42ch] text-[14px] text-[color:var(--text-muted)]">
            Paste the Reels you saved and Astrail will pull out the real places, check they exist, and connect them into a route you can follow.
          </p>
        </div>
      ) : (
        <>
          {/* Reel wallet — tap to fan out your saved Reels, drag one down to close. */}
          {cards.length ? (
            <section className="mb-6">
              <div className="mb-2 flex items-baseline justify-between gap-4">
                <h2 className="font-display text-[18px] font-medium text-[color:var(--text)]">Your reel folder</h2>
                <span className="text-[13px] text-[color:var(--text-faint)]">Tap to open</span>
              </div>
              <FolderGallery photos={folderPhotos} folderName="Saved reels" className="w-full" />
            </section>
          ) : null}

          {/* Saved Reels */}
          {cards.length ? (
            <section className="mb-10">
              <div className="mb-4 flex items-baseline justify-between gap-4">
                <h2 className="font-display text-[18px] font-medium text-[color:var(--text)]">Saved Reels</h2>
                <span className="text-[13px] text-[color:var(--text-faint)]">{cards.length} saved</span>
              </div>

              <div role="group" aria-label="Filter Reels" className="mb-4 flex flex-wrap gap-2">
                {REEL_FILTERS.map((f) => {
                  const on = reelFilter === f.key
                  const count = reelCounts[f.key]
                  return (
                    <button
                      key={f.key}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setReelFilter(f.key)}
                      className={`inline-flex min-h-9 items-center gap-2 rounded-full border px-4 text-[13px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)] ${
                        on
                          ? 'border-[color:var(--accent)] bg-[color:var(--accent)] text-[color:var(--accent-text)]'
                          : 'border-[color:var(--line-soft)] bg-[color:var(--surface-1)] text-[color:var(--text)] hover:bg-[color:var(--surface-2)]'
                      }`}
                    >
                      {f.label}
                      <span className={on ? 'opacity-70' : 'text-[color:var(--text-faint)]'}>{count}</span>
                    </button>
                  )
                })}
              </div>

              <ul className="flex gap-4 overflow-x-auto pb-3">
                {visibleCards.map((card) => {
                  const on = selected.includes(card.id)
                  return (
                    <li key={card.id} className="flex-none" style={{ width: 132 }}>
                      <button
                        type="button"
                        aria-pressed={selectionMode ? on : undefined}
                        onClick={() => { if (selectionMode) toggleSelect(card.id) }}
                        className={`w-full overflow-hidden rounded-lg border text-left transition-transform hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)] ${
                          on ? 'border-[color:var(--accent)]' : 'border-[color:var(--paper-line-2)]'
                        }`}
                      >
                        <div className="relative aspect-[9/16] bg-[color:var(--surface-2)]">
                          {card.thumbnail_url ? (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img src={card.thumbnail_url} alt="" className="h-full w-full object-cover" />
                          ) : null}
                          {selectionMode ? (
                            <span
                              aria-hidden
                              className={`absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border text-[11px] ${
                                on ? 'border-[color:var(--accent)] bg-[color:var(--accent)] text-[color:var(--accent-text)]' : 'border-[color:var(--paper-line-2)] bg-[color:var(--surface-1)]'
                              }`}
                            >
                              {on ? '✓' : ''}
                            </span>
                          ) : null}
                        </div>
                        <div className="px-3 py-2">
                          <span className="block truncate text-[13px] text-[color:var(--text)]">{card.personal_label ?? card.caption ?? 'Untitled'}</span>
                          <span className="mt-0.5 block text-[12px] text-[color:var(--text-muted)]">{reelStatusLabel(card)}</span>
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                {!selectionMode ? (
                  <button type="button" className={BTN_SECONDARY} onClick={() => setSelectionMode(true)}>Plan a trip from these</button>
                ) : (
                  <>
                    <span className="text-[12px] text-[color:var(--text-muted)]">{selected.length} / {MAX_SELECTED} selected</span>
                    <button type="button" disabled={busy || !selected.length} className={BTN_PRIMARY} onClick={() => void organize()}>Plan a trip</button>
                    <button type="button" className="min-h-9 px-2 text-[13px] text-[color:var(--text-muted)] hover:underline" onClick={() => { setSelectionMode(false); setSelected([]) }}>Cancel</button>
                  </>
                )}
              </div>
            </section>
          ) : null}

          {/* Your trails */}
          <section>
            <div className="mb-4 flex items-baseline justify-between gap-4">
              <h2 className="font-display text-[18px] font-medium text-[color:var(--text)]">Your trails</h2>
              <span className="text-[13px] text-[color:var(--text-faint)]">{trips.length} {trips.length === 1 ? 'trip' : 'trips'}</span>
            </div>

            {trips.length ? (
              <>
                <div role="group" aria-label="Filter trips" className="mb-4 flex flex-wrap gap-2">
                  {TRAIL_FILTERS.map((f) => {
                    const on = trailFilter === f.key
                    return (
                      <button
                        key={f.key}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setTrailFilter(f.key)}
                        className={`min-h-9 rounded-full border px-4 text-[13px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)] ${
                          on
                            ? 'border-[color:var(--accent)] bg-[color:var(--accent)] text-[color:var(--accent-text)]'
                            : 'border-[color:var(--line-soft)] bg-transparent text-[color:var(--text-muted)] hover:bg-[color:var(--surface-2)] hover:text-[color:var(--text)]'
                        }`}
                      >
                        {f.label}
                      </button>
                    )
                  })}
                </div>

                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                  {visibleTrips.map((trip) => (
                    <a
                      key={trip.id}
                      href={`/app/trip/${trip.id}`}
                      className="flex flex-col rounded-2xl border border-[color:var(--paper-line-2)] bg-[color:var(--surface-1)] p-4 transition-transform hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]"
                    >
                      <div aria-hidden className="mb-4 aspect-[4/3] rounded-lg border border-[color:var(--line-soft)] bg-[color:var(--surface-2)]" />
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="font-display text-[17px] font-medium text-[color:var(--text)]">{trip.title ?? 'Untitled trip'}</h3>
                          <p className="mt-1 text-[13px] text-[color:var(--text-muted)]">{tripMeta(trip)}</p>
                        </div>
                        <span className="flex-none whitespace-nowrap rounded-full border border-[color:var(--line-soft)] px-2 py-0.5 text-[11px] uppercase tracking-wide text-[color:var(--text-muted)]">
                          {TRIP_BADGE[trip.status]}
                        </span>
                      </div>
                    </a>
                  ))}
                </div>
              </>
            ) : (
              <p className="rounded-2xl border border-dashed border-[color:var(--line-soft)] px-5 py-8 text-[14px] text-[color:var(--text-muted)]">
                No trips yet. Select some saved Reels above and plan your first one.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  )
}
