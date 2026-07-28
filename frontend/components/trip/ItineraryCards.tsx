'use client'

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
  if (places.length === 0) {
    return <p className="type-body text-sm text-[var(--muted)]">No stops planned for this day.</p>
  }
  return (
    <ol className="flex flex-col gap-2">
      {places.map((tp, i) => {
        const selected = tp.place_id === selectedPlaceId
        return (
          <li key={tp.id}>
            <button
              type="button"
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
