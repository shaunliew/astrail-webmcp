'use client'

import Link from 'next/link'
import type { Trip } from '@/lib/trip/backend-types'
import {
  tripTitle,
  tripDateRange,
  tripStatusLabel,
  statusDotClass,
  budgetLabel,
} from '@/lib/trip/trip-presenters'
import RouteGlyph from './RouteGlyph'

/* One row in the trip inventory (middle pane). The whole row is a select control — clicking
   it drives the map on the right, it does NOT navigate. The selected row reveals an explicit
   "Open trip" footer link into the full workspace, so selection and navigation stay distinct
   (no nested interactives). Palette role tokens only — the inventory is a paper surface. */

export default function TripRow({
  trip,
  selected,
  onSelect,
}: {
  trip: Trip
  selected: boolean
  onSelect: () => void
}) {
  const title = tripTitle(trip)

  return (
    <li
      className={[
        'overflow-hidden rounded-xl border transition-colors',
        selected
          ? 'border-[color:var(--brass-deep)] bg-[color:var(--brass-wash)]'
          : 'border-transparent hover:bg-[color:var(--surface-2)]',
      ].join(' ')}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex w-full items-start gap-3 px-3 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]"
      >
        <RouteGlyph tripId={trip.id} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span
              className="font-display truncate text-[15px] text-[color:var(--text)]"
              style={{ fontVariationSettings: "'SOFT' 28, 'WONK' 0, 'opsz' 16" }}
            >
              {title}
            </span>
            <span className="inline-flex shrink-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">
              <span aria-hidden className={statusDotClass(trip.status)} />
              {tripStatusLabel(trip.status)}
            </span>
          </span>
          <span className="mt-0.5 block text-[13px] text-[color:var(--text-muted)]">
            {tripDateRange(trip)}
          </span>
          <span className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] uppercase tracking-wide text-[color:var(--text-faint)]">
            <span>{budgetLabel(trip.budget_level)}</span>
            {trip.origin_city ? <span>from {trip.origin_city}</span> : null}
          </span>
        </span>
      </button>

      {selected ? (
        <Link
          href={`/app/trip/${trip.id}`}
          aria-label={`Open ${title} trip`}
          className="flex items-center justify-center gap-1 border-t border-[color:var(--line)] px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--brass-deep)] transition-colors hover:bg-[color:var(--brass-wash)]"
        >
          Open trip →
        </Link>
      ) : null}
    </li>
  )
}
