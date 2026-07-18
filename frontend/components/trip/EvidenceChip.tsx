import type { TripPlaceEvidence, EvidenceKind } from '@/lib/trip/backend-types'

const KIND_LABEL: Record<EvidenceKind, string> = {
  reel_quote: 'Reel',
  requested_by_you: 'You',
  suggested_by_astrail: 'Astrail',
  research: 'Research',
  mapbox_route: 'Mapbox',
  open_meteo: 'Weather',
  travala_hotel_search: 'Travala',
  memory_preference: 'Memory',
  inferred_default: 'Default',
}

export default function EvidenceChip({ evidence }: { evidence: TripPlaceEvidence }) {
  const pct = `${Math.round(evidence.confidence * 100)}%`
  const label = KIND_LABEL[evidence.evidence_kind]
  return (
    <span className="type-evidence inline-flex items-center gap-1.5 rounded-[var(--radius-chip)] bg-[var(--chip-bg)] px-2 py-0.5 text-[10px] tracking-wide text-[var(--muted)]">
      <span className="font-semibold uppercase text-[var(--brass-bright)]">{label}</span>
      <span>{pct}</span>
      {evidence.source_url ? (
        <a
          href={evidence.source_url}
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-dotted underline-offset-2 hover:text-[var(--starlight)]"
        >
          source
        </a>
      ) : null}
    </span>
  )
}
