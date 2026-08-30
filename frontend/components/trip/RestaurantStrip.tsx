import type { RestaurantSuggestion, Place } from '@/lib/trip/backend-types'
import { safeHref } from '@/lib/safe-href'

export default function RestaurantStrip({
  restaurants, placeIndex, selectedPlaceId = null, onSelect,
}: {
  restaurants: RestaurantSuggestion[]
  placeIndex: Map<string, Place>
  selectedPlaceId?: string | null
  /**
   * Focus this suggestion on the map. Optional so the strip still renders in contexts with no
   * map — but where there IS one, a suggestion you can read and not locate is half an answer.
   */
  onSelect?: (placeId: string) => void
}) {
  if (restaurants.length === 0) {
    return (
      <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--line)] p-3">
        <p className="type-body text-xs text-[var(--muted)]">
          Astrail didn&apos;t find restaurants near this route yet.
        </p>
      </div>
    )
  }
  return (
    <ul className="flex flex-col gap-2">
      {restaurants.map((r) => {
        const place = r.restaurant_place_id ? placeIndex.get(r.restaurant_place_id) : undefined
        // Only locatable suggestions become interactive — a button that cannot move the map is
        // worse than plain text, because it promises something it will not do.
        const locatable = Boolean(place && onSelect)
        const isSelected = Boolean(place && place.id === selectedPlaceId)
        return (
          <li
            key={r.id}
            className={[
              'surface rounded-lg p-2.5 transition',
              locatable ? 'hover:border-[var(--brass-bright)]' : '',
              isSelected ? 'border-[var(--brass-bright)]' : '',
            ].filter(Boolean).join(' ')}
            {...(locatable
              ? {
                  role: 'button',
                  tabIndex: 0,
                  'aria-pressed': isSelected,
                  'aria-label': `Show ${place!.name} on the map`,
                  onClick: () => onSelect!(place!.id),
                  onKeyDown: (e: React.KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onSelect!(place!.id)
                    }
                  },
                }
              : {})}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="type-display truncate text-sm text-[var(--starlight)]">
                {place?.name ?? 'Suggested spot'}
              </span>
              {r.cuisine ? (
                <span className="type-label shrink-0 text-[10px] uppercase tracking-wide text-[var(--brass-bright)]">
                  {r.cuisine}
                </span>
              ) : null}
            </div>
            <p className="type-body mt-1 text-xs text-[var(--muted)]">{r.summary}</p>
            {safeHref(r.source_url) ? (
              <a
                href={safeHref(r.source_url)}
                target="_blank"
                rel="noopener noreferrer"
                className="type-label text-[10px] text-[var(--brass-bright)] underline decoration-dotted underline-offset-2"
              >
                evidence
              </a>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
