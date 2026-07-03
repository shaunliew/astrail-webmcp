import type { TripBundle } from '@/lib/trip/backend-types'

function Stat({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="flex flex-col">
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
        <h2 className="type-display text-lg text-[var(--starlight)]">{bundle.trip.title ?? 'Your trip'}</h2>
        {withGaps ? (
          <span className="type-label rounded-full border border-[var(--brass)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--brass)]">
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
