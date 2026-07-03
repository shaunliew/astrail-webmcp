import type { RestaurantSuggestion, Place } from '@/lib/trip/backend-types'

export default function RestaurantStrip({
  restaurants, placeIndex,
}: {
  restaurants: RestaurantSuggestion[]
  placeIndex: Map<string, Place>
}) {
  if (restaurants.length === 0) {
    return <p className="type-body text-xs text-[var(--muted)]">No restaurant picks for this day.</p>
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
                <span className="type-label shrink-0 text-[10px] uppercase tracking-wide text-[var(--brass)]">
                  {r.cuisine}
                </span>
              ) : null}
            </div>
            <p className="type-body mt-1 text-xs text-[var(--muted)]">{r.summary}</p>
            {r.source_url ? (
              <a
                href={r.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="type-label text-[10px] text-[var(--brass)] underline decoration-dotted underline-offset-2"
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
