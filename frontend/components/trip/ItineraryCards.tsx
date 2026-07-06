'use client'

import type { TripPlace, PlaceSourceType } from '@/lib/trip/backend-types'
import EvidenceChip from './EvidenceChip'

const SOURCE_BADGE: Record<PlaceSourceType, string> = {
  reel_extracted: 'From reel',
  user_requested: 'You asked',
  agent_suggested: 'Astrail pick',
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
                <span className="type-label shrink-0 rounded border border-[var(--line)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--muted)]">
                  {SOURCE_BADGE[tp.source_type]}
                </span>
              </div>
              {tp.evidence_json.quote ? (
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
