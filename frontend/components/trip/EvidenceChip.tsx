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
    <span className="type-label inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--brass-soft)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--brass)]">
      <span aria-hidden className="h-1 w-1 rounded-full bg-[var(--brass)]" />
      {label}
      <span className="text-[var(--muted)]">{pct}</span>
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
