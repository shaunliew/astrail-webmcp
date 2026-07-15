import Link from 'next/link'
import type { Trip } from '@/lib/trip/backend-types'
import { tripTitle, tripDateRange, tripStatusLabel, budgetLabel } from '@/lib/trip/trip-presenters'

export default function TripCard({ trip }: { trip: Trip }) {
  return (
    <Link
      href={`/app/trip/${trip.id}`}
      className="surface flex flex-col gap-2 rounded-xl p-4 transition-colors hover:border-[var(--brass)]"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="type-display text-lg text-[var(--starlight)]">{tripTitle(trip)}</h3>
        <span className="type-label inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--brass-soft)] px-2.5 py-1 text-[10.5px] text-[var(--brass-bright)]">
          <span aria-hidden className="pulse-dot" />
          {tripStatusLabel(trip.status)}
        </span>
      </div>
      <p className="type-body text-sm text-[var(--muted)]">{tripDateRange(trip)}</p>
      <div className="type-label flex flex-wrap gap-x-3 gap-y-1 text-[10px] uppercase tracking-wide text-[var(--faint)]">
        <span>{budgetLabel(trip.budget_level)}</span>
        {trip.origin_city ? <span>from {trip.origin_city}</span> : null}
      </div>
    </Link>
  )
}
