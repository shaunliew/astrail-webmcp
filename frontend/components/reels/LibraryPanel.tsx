'use client'

import { useMemo, useState } from 'react'
import SocialCards, { type CardItem } from '@/components/ui/card-fan-carousel'
import type { SavedReelAnalysisStatus, SavedReelCard } from '@/lib/reels/backend-types'

/* LibraryPanel — the full-surface "Library" reached from the Trays home banner. It browses
   every saved reel with a country filter + search, in two modes:
   - Browse (default): the card-fan carousel; tapping a reel fires onOpenReel (P2/T2.1 opens
     the real ReelInfoCard; the parent passes a no-op stub in P1).
   - Select: a selectable tile grid that preserves the plan-from-loose-reels journey — pick
     up to five reels and hand them to onOrganize (the same callback DashboardHome used, per
     DECISION B). Migrated here from TraysScreen's interim libraryOpen block.

   It fills the paper <main> (the Trays home content is swapped out while it is open); it is
   NOT a fixed inset-0 over-the-map overlay — the /app home has no map behind it. */

// Backend GenerateTripRequest caps place_ids at 5 (api/schemas.py); the select→organize
// path mirrors SavedReelsFlow's MAX_PLACES so a sixth pick can't 422.
const MAX_SELECTED = 5

type Mode = 'browse' | 'select'

// Select-mode status caption when a reel has no grounded places yet. A reel WITH places
// always reads "Places found · N"; this map covers the place-less states (organized-but-zero
// grounded still reads as "Places found · 0", per the T1.2 reviewer carry-over).
const STATUS_LABELS: Record<SavedReelAnalysisStatus, string> = {
  not_analyzed: 'Not analyzed',
  queued: 'Queued',
  processing: 'Analyzing…',
  organized: 'Places found · 0',
  location_not_found: 'No places found',
  failed: 'Analysis failed',
}

function statusLabel(cardItem: SavedReelCard): string {
  if (cardItem.places.length > 0) return `Places found · ${cardItem.places.length}`
  return STATUS_LABELS[cardItem.analysis_status]
}

function reelLabel(cardItem: SavedReelCard): string {
  return cardItem.personal_label ?? cardItem.caption ?? 'Untitled reel'
}

const BTN_PRIMARY =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[color:var(--accent)] bg-[color:var(--accent)] px-4 text-[13px] font-medium text-[color:var(--accent-text)] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]'
const CHIP_BASE =
  'inline-flex min-h-11 items-center rounded-full border px-4 text-[13px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]'
const CHIP_ON = 'border-[color:var(--accent)] bg-[color:var(--accent)] text-[color:var(--accent-text)]'
const CHIP_OFF = 'border-[color:var(--paper-line-2)] bg-transparent text-[color:var(--text)] hover:bg-[color:var(--surface-2)]'
const TOGGLE_BASE =
  'min-h-11 rounded-lg px-4 text-[13px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]'
const TOGGLE_ON = 'bg-[color:var(--surface-1)] text-[color:var(--text)] shadow-sm'
const TOGGLE_OFF = 'text-[color:var(--text-muted)] hover:text-[color:var(--text)]'

export default function LibraryPanel({
  cards,
  onClose,
  onOpenReel,
  onOrganize,
}: {
  cards: SavedReelCard[]
  onClose: () => void
  onOpenReel: (card: SavedReelCard) => void
  onOrganize: (ids: string[]) => Promise<void>
}) {
  const [mode, setMode] = useState<Mode>('browse')
  const [country, setCountry] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const cardById = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards])

  // Country chips are derived from every card's places (not the filtered list), so switching
  // the active country never removes the chip you'd switch back through. Code → display name.
  const countries = useMemo(() => {
    const byCode = new Map<string, string>()
    for (const c of cards) {
      for (const p of c.places) {
        if (!byCode.has(p.country_code)) byCode.set(p.country_code, p.country_name || p.country_code)
      }
    }
    return Array.from(byCode, ([code, label]) => ({ code, label })).sort((a, b) => a.label.localeCompare(b.label))
  }, [cards])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return cards.filter((c) => {
      if (country && !c.places.some((p) => p.country_code === country)) return false
      if (q) {
        const haystack = [c.caption, c.personal_label, ...c.places.map((p) => p.name)]
          .filter((v): v is string => Boolean(v))
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }, [cards, country, search])

  const fanCards: CardItem[] = useMemo(
    () =>
      filtered.map((c) => ({
        id: c.id,
        imgUrl: c.thumbnail_url ?? '',
        alt: c.personal_label ?? c.caption ?? 'Saved reel',
      })),
    [filtered],
  )

  function openFanCard(item: CardItem) {
    const match = item.id ? cardById.get(item.id) : undefined
    if (match) onOpenReel(match)
  }

  function toggleSelect(id: string) {
    setSelected((current) =>
      current.includes(id)
        ? current.filter((v) => v !== id)
        : current.length < MAX_SELECTED
          ? [...current, id]
          : current,
    )
  }

  async function organize() {
    if (!selected.length) return
    setBusy(true)
    setMessage(null)
    try {
      await onOrganize(selected)
      // On success the parent flow advances (organize job) and unmounts this panel; leave
      // busy set so a double-submit can't slip through the transition.
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not organize those Reels.')
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col">
      <header className="mb-6">
        <button
          type="button"
          onClick={onClose}
          className="mb-4 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]"
        >
          <span aria-hidden>←</span> Back
        </button>

        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[26px] font-medium tracking-[-0.01em] text-[color:var(--text)]">
              Your saved reels live here
            </h1>
            <p className="mt-1 text-[13px] text-[color:var(--text-muted)]">
              {cards.length} saved · browse the fan or select up to {MAX_SELECTED} to plan a trip.
            </p>
          </div>

          {/* Mode toggle */}
          <div
            role="group"
            aria-label="Library mode"
            className="inline-flex gap-1 rounded-xl border border-[color:var(--paper-line-2)] bg-[color:var(--surface-2)] p-1"
          >
            <button
              type="button"
              aria-pressed={mode === 'browse'}
              onClick={() => setMode('browse')}
              className={`${TOGGLE_BASE} ${mode === 'browse' ? TOGGLE_ON : TOGGLE_OFF}`}
            >
              Browse
            </button>
            <button
              type="button"
              aria-pressed={mode === 'select'}
              onClick={() => setMode('select')}
              className={`${TOGGLE_BASE} ${mode === 'select' ? TOGGLE_ON : TOGGLE_OFF}`}
            >
              Select
            </button>
          </div>
        </div>
      </header>

      {/* Country filter chips */}
      <div className="mb-4 flex flex-wrap gap-2">
        <button
          type="button"
          aria-pressed={country === null}
          onClick={() => setCountry(null)}
          className={`${CHIP_BASE} ${country === null ? CHIP_ON : CHIP_OFF}`}
        >
          All
        </button>
        {countries.map((c) => (
          <button
            key={c.code}
            type="button"
            aria-pressed={country === c.code}
            onClick={() => setCountry(c.code)}
            className={`${CHIP_BASE} ${country === c.code ? CHIP_ON : CHIP_OFF}`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="mb-6">
        <label htmlFor="library-search" className="sr-only">Search saved reels</label>
        <input
          id="library-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by caption, label, or place…"
          className="min-h-11 w-full rounded-lg border border-[color:var(--line-soft)] bg-[color:var(--surface-1)] px-4 text-[color:var(--text)] placeholder:text-[color:var(--text-faint)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]"
        />
      </div>

      {message ? (
        <p role="alert" className="mb-4 rounded-lg border border-dashed border-[color:var(--line-soft)] bg-[color:var(--surface-2)] p-3 text-[13px] text-[color:var(--text-muted)]">
          {message}
        </p>
      ) : null}

      {filtered.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-[color:var(--line-soft)] px-6 py-16 text-center text-[14px] text-[color:var(--text-muted)]">
          {cards.length === 0
            ? 'No saved reels yet. Paste a Reel link on your home to start your library.'
            : 'No saved reels match these filters.'}
        </p>
      ) : mode === 'browse' ? (
        <SocialCards cards={fanCards} onOpen={openFanCard} />
      ) : (
        <>
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {filtered.map((c) => {
              const on = selected.includes(c.id)
              const label = reelLabel(c)
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    aria-label={`Select ${label}`}
                    onClick={() => toggleSelect(c.id)}
                    className={`w-full overflow-hidden rounded-lg border text-left transition-transform hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)] ${
                      on ? 'border-[color:var(--accent)]' : 'border-[color:var(--paper-line-2)]'
                    }`}
                  >
                    <div className="relative aspect-[9/16] bg-[color:var(--surface-2)]">
                      {c.thumbnail_url ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img src={c.thumbnail_url} alt="" className="h-full w-full object-cover" />
                      ) : null}
                      <span
                        aria-hidden
                        className={`absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border text-[11px] ${
                          on
                            ? 'border-[color:var(--accent)] bg-[color:var(--accent)] text-[color:var(--accent-text)]'
                            : 'border-[color:var(--paper-line-2)] bg-[color:var(--surface-1)]'
                        }`}
                      >
                        {on ? '✓' : ''}
                      </span>
                    </div>
                    <span className="block truncate px-3 pt-2 text-[13px] text-[color:var(--text)]">{label}</span>
                    <span className="block px-3 pb-2 text-[12px] text-[color:var(--text-faint)]">{statusLabel(c)}</span>
                  </button>
                </li>
              )
            })}
          </ul>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <span className="text-[12px] text-[color:var(--text-muted)]">{selected.length} / {MAX_SELECTED} selected</span>
            <button type="button" disabled={busy || !selected.length} className={BTN_PRIMARY} onClick={() => void organize()}>
              Plan a trip
            </button>
            {selected.length ? (
              <button
                type="button"
                className="min-h-9 px-2 text-[13px] text-[color:var(--text-muted)] hover:underline"
                onClick={() => setSelected([])}
              >
                Clear
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  )
}
