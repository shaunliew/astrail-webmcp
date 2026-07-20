import type { TripPlace } from '@/lib/trip/backend-types'
import EvidenceChip from './EvidenceChip'

export default function PlaceIntelPanel({ tripPlace }: { tripPlace: TripPlace | null }) {
  if (!tripPlace) {
    return (
      <div className="surface rounded-xl p-4">
        <p className="type-body text-sm text-[var(--muted)]">Select a place to see its evidence.</p>
      </div>
    )
  }
  const { place, evidence_json: ev } = tripPlace
  return (
    <div className="surface rounded-xl p-4">
      <span className="type-label text-[10px] uppercase tracking-wide text-[var(--faint)]">{place.place_type}</span>
      <h3 className="type-display text-xl leading-tight text-[var(--starlight)]">{place.name}</h3>
      <p className="type-body text-xs text-[var(--muted)]">
        {[place.area, place.city, place.country].filter(Boolean).join(', ')}
      </p>
      {ev.quote ? (
        /* The reel quote is the voice of the source, not the UI (DESIGN.md G2, resolved
           serif): italic display serif over the brass quote-bar. Serif never drops below
           18px, so only focus surfaces like this one carry it — compact card previews
           (ItineraryCards) keep the sans-italic fallback at caption sizes. */
        <blockquote className="type-display mt-3 border-l border-[var(--brass)] pl-3 text-lg italic leading-snug text-[var(--muted)]">
          "{ev.quote}"
        </blockquote>
      ) : null}
      {ev.rationale ? (
        <p className="type-body mt-3 text-sm text-[var(--muted)]">{ev.rationale}</p>
      ) : null}
      <div className="mt-3">
        <EvidenceChip evidence={ev} />
      </div>
    </div>
  )
}
