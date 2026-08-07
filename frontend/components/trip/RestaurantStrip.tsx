import type { RestaurantSuggestion, Place } from '@/lib/trip/backend-types'
import { safeHref } from '@/lib/safe-href'

export default function RestaurantStrip({
  restaurants, placeIndex,
}: {
  restaurants: RestaurantSuggestion[]
  placeIndex: Map<string, Place>
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
        return (
          <li key={r.id} className="surface rounded-lg p-2.5">
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
