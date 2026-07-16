import Link from 'next/link'
import type { Trip } from '@/lib/trip/backend-types'
import { tripTitle, tripDateRange, tripStatusLabel, budgetLabel } from '@/lib/trip/trip-presenters'

type RoutePoint = { x: number; y: number }

function routePoints(id: string): [RoutePoint, RoutePoint, RoutePoint] {
  let hash = 2166136261
  for (const character of id) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }

  const next = () => {
    hash = Math.imul(hash ^ (hash >>> 16), 2246822507)
    hash = Math.imul(hash ^ (hash >>> 13), 3266489909)
    return ((hash ^= hash >>> 16) >>> 0) / 4294967296
  }

  return [
    { x: 8 + next() * 12, y: 11 + next() * 18 },
    { x: 31 + next() * 10, y: 7 + next() * 24 },
    { x: 56 + next() * 10, y: 11 + next() * 18 },
  ]
}

function RouteGlyph({ tripId }: { tripId: string }) {
  const [start, middle, end] = routePoints(tripId)
  const firstControl = { x: (start.x + middle.x) / 2, y: Math.min(start.y, middle.y) - 7 }
  const secondControl = { x: (middle.x + end.x) / 2, y: Math.min(middle.y, end.y) - 7 }

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="72"
      height="40"
      viewBox="0 0 72 40"
      className="shrink-0"
    >
      <path
        d={`M ${start.x} ${start.y} Q ${firstControl.x} ${firstControl.y} ${middle.x} ${middle.y} Q ${secondControl.x} ${secondControl.y} ${end.x} ${end.y}`}
        fill="none"
        stroke="var(--brass)"
        strokeDasharray="1.5 4"
        strokeLinecap="round"
        strokeOpacity="0.6"
        strokeWidth="1.2"
      />
      {[start, middle, end].map((point, index) => (
        <circle key={index} cx={point.x} cy={point.y} r="2.5" fill="var(--brass-deep)" />
      ))}
    </svg>
  )
}

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
            <span aria-hidden className="pulse-dot" />
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
