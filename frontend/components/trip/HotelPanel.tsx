import type { HotelSuggestion, HotelStatus } from '@/lib/trip/backend-types'

const STATUS_LABEL: Record<HotelStatus, string> = {
  suggested: 'Suggested',
  unavailable: 'Unavailable',
  skipped: 'Skipped',
  failed: 'Search failed',
}

// The hotel list doubles as the hub picker (plan 2026-08-04-hotel-hub-map, T8). Only hotels the
// backend actually geocoded (`geo_status==='placed'`) can become the map hub — an unresolved hotel
// has no pin to select (Guardrail #1), so it renders as a plain, non-interactive row with an honest
// "couldn't place it" note. `layerMode` is load-bearing: the picked hub is only DRAWN on the map in
// hub mode, so the "On map" indicator only appears there (in route mode the selection is latent).
export default function HotelPanel({
  hotels, selectedHotelId, onSelectHotel, layerMode,
}: {
  hotels: HotelSuggestion[]
  selectedHotelId: string | null
  onSelectHotel: (id: string) => void
  layerMode: 'route' | 'hub'
}) {
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
        const placed = h.geo_status === 'placed'
        const selected = placed && h.id === selectedHotelId
        const meta = [h.area, h.star_rating ? `${h.star_rating}★` : null].filter(Boolean).join(' · ')

        // Identical body whether or not the row is a selectable hub-pick button.
        const body = (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="type-display truncate text-sm text-[var(--starlight)]">{h.name}</span>
              <span className="type-label shrink-0 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                {STATUS_LABEL[h.status]}
              </span>
            </div>
            {(h.is_recommended || (selected && layerMode === 'hub')) ? (
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {h.is_recommended ? (
                  <span className="type-label rounded-[var(--radius-chip)] bg-[var(--brass-soft)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--brass-bright)]">
                    Recommended
                  </span>
                ) : null}
                {/* Only the hub actually drawn on the map (hub mode) says so — honest about state. */}
                {selected && layerMode === 'hub' ? (
                  <span className="type-label rounded-[var(--radius-chip)] border border-[var(--line)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--muted)]">
                    On map
                  </span>
                ) : null}
              </div>
            ) : null}
            {meta ? <p className="type-body mt-1 text-xs text-[var(--muted)]">{meta}</p> : null}
            {/* Honest-failure (Guardrail #1): an unplaceable hotel is never pinned; say why. */}
            {h.geo_status === 'unresolved' ? (
              <p className="type-body mt-1 text-[11px] text-[var(--muted)]">
                We couldn&apos;t place this hotel on the map.
              </p>
            ) : null}
          </>
        )

        if (placed) {
          return (
            <li key={h.id}>
              <button
                type="button"
                onClick={() => onSelectHotel(h.id)}
                aria-pressed={selected}
                className={[
                  'surface w-full rounded-lg p-2.5 text-left transition-colors',
                  selected ? 'border-[var(--brass)]' : 'hover:border-[var(--brass)]',
                ].join(' ')}
              >
                {body}
              </button>
            </li>
          )
        }
        return (
          <li key={h.id} className={['surface rounded-lg p-2.5', inactive ? 'opacity-60' : ''].join(' ')}>
            {body}
          </li>
        )
      })}
    </ul>
  )
}
