import Link from 'next/link'
import type { Trip } from '@/lib/trip/backend-types'
import { tripTitle, tripDateRange, tripStatusLabel, statusDotClass, budgetLabel } from '@/lib/trip/trip-presenters'
import RouteGlyph from './RouteGlyph'

export default function TripCard({ trip }: { trip: Trip }) {
  return (
    <Link
      href={`/app/trip/${trip.id}`}
      className="trip-card surface group flex items-start gap-4 rounded-[var(--radius-card)] p-4 transition-shadow hover:shadow-[0_10px_30px_rgba(26,24,16,0.2)]"
    >
      <RouteGlyph tripId={trip.id} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="type-display truncate text-lg text-[var(--starlight)]">{tripTitle(trip)}</h3>
            <p className="type-body text-sm text-[var(--muted)]">{tripDateRange(trip)}</p>
          </div>
          <span className="type-label inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--brass-soft)] px-2.5 py-1 text-[10.5px] text-[var(--brass-bright)]">
            <span aria-hidden className={statusDotClass(trip.status)} />
            {tripStatusLabel(trip.status)}
          </span>
        </div>
        <div className="type-label mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[10px] uppercase tracking-wide text-[var(--faint)]">
          <span>{budgetLabel(trip.budget_level)}</span>
          {trip.origin_city ? <span>from {trip.origin_city}</span> : null}
        </div>
      </div>
    </Link>
  )
}
