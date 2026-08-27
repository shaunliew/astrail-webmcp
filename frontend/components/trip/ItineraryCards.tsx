'use client'

import { useEffect, useRef } from 'react'
import type { TripPlace, PlaceSourceType } from '@/lib/trip/backend-types'
import EvidenceChip from './EvidenceChip'

const SOURCE_BADGE: Record<PlaceSourceType, string> = {
  reel_extracted: 'From reel',
  user_requested: 'You asked',
  agent_suggested: 'Astrail pick',
}

/* A quote earns its space only when it says something the heading did not.
   Real captions very often yield an evidence quote that IS the place name —
   "📍Tokyo Dream Park" against a stop called Tokyo Dream Park — and rendering it
   prints the same words twice, the second time in a decorative face. The evidence
   chip still carries the provenance, so nothing is hidden by dropping the echo. */
function addsNothing(quote: string, name: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase()
      .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')   // strips 📍, quotes, dashes, punctuation
      .trim()
  const q = norm(quote)
  const n = norm(name)
  return q.length === 0 || q === n || n.includes(q)
}

export default function ItineraryCards({
  places, selectedPlaceId, onSelectPlace,
}: {
  places: TripPlace[]
  selectedPlaceId: string | null
  onSelectPlace: (placeId: string) => void
}) {
  const listRef = useRef<HTMLOListElement>(null)

  // A selection can arrive from somewhere the card list cannot see: a tap on a map pin, or the
  // agent calling show_on_map. On mobile that was invisible — the map's evidence popup opens
  // inside `.shared-map`, which is `position: fixed; z-index: 0` and therefore its own stacking
  // context, so the popup can never paint above the `z-10` details sheet covering ~65% of a
  // phone screen. No z-index fixes that. Bringing the matching CARD into view instead uses the
  // surface mobile already has, and fixes the agent's direction on desktop for free.
  useEffect(() => {
    if (!selectedPlaceId) return
    const card = listRef.current?.querySelector(`[data-place-id="${CSS.escape(selectedPlaceId)}"]`)
    // 'nearest' so a card already on screen does not jolt — clicking a card must not scroll it.
    card?.scrollIntoView({
      block: 'nearest',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    })
  }, [selectedPlaceId])

  if (places.length === 0) {
    return <p className="type-body text-sm text-[var(--muted)]">No stops planned for this day.</p>
  }
  return (
    <ol ref={listRef} className="flex flex-col gap-2">
      {places.map((tp, i) => {
        const selected = tp.place_id === selectedPlaceId
        return (
          <li key={tp.id}>
            <button
              type="button"
              data-place-id={tp.place_id}
              aria-current={selected ? 'true' : undefined}
              onClick={() => onSelectPlace(tp.place_id)}
              className={[
                'surface w-full rounded-xl p-3 text-left transition-colors',
                selected ? 'border-[var(--brass)]' : 'hover:border-[var(--brass)]',
              ].join(' ')}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <span className="type-label text-[10px] text-[var(--faint)]">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <h3 className="type-display truncate text-lg leading-tight text-[var(--starlight)]">
                    {tp.place.name}
                  </h3>
                  <p className="type-body text-xs text-[var(--muted)]">
                    {[tp.place.place_type, tp.place.area, tp.place.city].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <span className="type-label shrink-0 rounded-[var(--radius-chip)] border border-[var(--line)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--muted)]">
                  {SOURCE_BADGE[tp.source_type]}
                </span>
              </div>
              {tp.evidence_json.quote && !addsNothing(tp.evidence_json.quote, tp.place.name) ? (
                /* Compact quote preview: sans-italic on purpose — the serif quote face
                   never drops below 18px (DESIGN.md G2), and this caption is 12px. */
                <p className="type-body mt-2 border-l border-[var(--brass)] pl-2 text-xs italic text-[var(--muted)]">
                  "{tp.evidence_json.quote}"
                </p>
              ) : null}
              <div className="mt-2">
                <EvidenceChip evidence={tp.evidence_json} />
              </div>
            </button>
          </li>
        )
      })}
    </ol>
  )
}
