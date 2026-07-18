import type { HotelSuggestion, HotelStatus } from '@/lib/trip/backend-types'

const STATUS_LABEL: Record<HotelStatus, string> = {
  suggested: 'Suggested',
  unavailable: 'Unavailable',
  skipped: 'Skipped',
  failed: 'Search failed',
}

export default function HotelPanel({ hotels }: { hotels: HotelSuggestion[] }) {
  if (hotels.length === 0) {
    return (
      <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--line)] p-3">
        <p className="type-body text-xs text-[var(--muted)]">No hotel suggestions for these dates.</p>
      </div>
    )
  }
  return (
    <ul className="flex flex-col gap-2">
      {hotels.map((h) => {
        const inactive = h.status !== 'suggested'
        return (
          <li key={h.id} className={['surface rounded-lg p-2.5', inactive ? 'opacity-60' : ''].join(' ')}>
            <div className="flex items-center justify-between gap-2">
              <span className="type-display truncate text-sm text-[var(--starlight)]">{h.name}</span>
              <span className="type-label shrink-0 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                {STATUS_LABEL[h.status]}
              </span>
            </div>
            <p className="type-body mt-1 text-xs text-[var(--muted)]">
              {[h.area, h.star_rating ? `${h.star_rating}★` : null].filter(Boolean).join(' · ')}
            </p>
          </li>
        )
      })}
    </ul>
  )
}
