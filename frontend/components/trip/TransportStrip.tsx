import type { TransportLeg, TransportStatus, Place } from '@/lib/trip/backend-types'

const OK_STATUSES: TransportStatus[] = ['ok']

function fmtDuration(seconds: number | null): string {
  if (seconds == null) return ''
  const m = Math.round(seconds / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`
}

export default function TransportStrip({
  legs, placeIndex,
}: {
  legs: TransportLeg[]
  placeIndex: Map<string, Place>
}) {
  if (legs.length === 0) {
    return (
      <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--line)] p-3">
        <p className="type-body text-xs text-[var(--muted)]">No route legs for this day.</p>
      </div>
    )
  }
  const name = (id: string | null) => (id ? placeIndex.get(id)?.name ?? 'Unknown' : 'Unknown')
  return (
    <ul className="flex flex-col gap-2">
      {legs.map((leg) => {
        const routed = OK_STATUSES.includes(leg.status)
        return (
          <li key={leg.id} className="surface rounded-lg p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="type-body truncate text-xs text-[var(--starlight)]">
                {name(leg.from_place_id)} <span className="text-[var(--faint)]">→</span> {name(leg.to_place_id)}
              </span>
              <span className="type-label shrink-0 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                {leg.transport_mode.replace('_', ' ')}
              </span>
            </div>
            {routed ? (
              <p className="type-label mt-1 text-[11px] tabular-nums text-[var(--brass-bright)]">
                {fmtDuration(leg.duration_seconds)}
                {leg.distance_meters != null ? ` · ${(leg.distance_meters / 1000).toFixed(1)} km` : ''}
              </p>
            ) : (() => {
              const msg = `No route. ${leg.warning ?? 'Routing unavailable for this leg.'}`
              return (
                <p className="type-body mt-1 text-[11px] text-[var(--muted)]">
                  {msg}
                </p>
              )
            })()}
          </li>
        )
      })}
    </ul>
  )
}
