import type { TripBundle } from '@/lib/trip/backend-types'

function Stat({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="flex flex-col" data-testid={`stat-${label}`}>
      <span className="type-display text-2xl leading-none text-[var(--starlight)]">{value}</span>
      <span className="type-label text-[10px] uppercase tracking-wide text-[var(--faint)]">{label}</span>
    </div>
  )
}

export default function OrchestratorSummary({ bundle }: { bundle: TripBundle }) {
  const withGaps = bundle.trip.status === 'saved_with_gaps'
  return (
    <div className="surface rounded-xl p-4">
      <div className="flex items-center justify-between">
        <h2 className="type-display text-lg text-[var(--starlight)]">{bundle.trip.inferred_destination ?? bundle.trip.destination_hint ?? 'Your trip'}</h2>
        {withGaps ? (
          <span className="type-label inline-flex items-center gap-1.5 rounded-full bg-[var(--brass-soft)] px-2.5 py-1 text-[10.5px] text-[var(--brass-bright)]">
            <span aria-hidden className="pulse-dot pulse-dot--warn" />
            Saved with gaps
          </span>
        ) : null}
      </div>
      <div className="mt-3 grid grid-cols-4 gap-2">
        <Stat value={bundle.places.length} label="places" />
        <Stat value={bundle.days.length} label="days" />
        <Stat value={bundle.transport_legs.length} label="legs" />
        <Stat value={bundle.inspiration.length} label="sources" />
      </div>
    </div>
  )
}
