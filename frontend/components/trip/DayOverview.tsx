import type { TripDay } from '@/lib/trip/backend-types'

// The narrated day. title + summary are the "Writing your days" stage's output
// (PRD §15) — shipped in every bundle, previously rendered nowhere. Weather rides
// with a mono source tag (the TradeoffPanel provenance pattern; open_meteo is the
// only v1 source). A day beyond the forecast window simply has no weather line —
// partial output is acceptable (PRD §17), and we don't invent a reason we don't know.
export default function DayOverview({ day }: { day: TripDay }) {
  if (!day.title && !day.summary && !day.weather_summary) return null
  return (
    <div className="flex flex-col gap-1">
      {day.title ? (
        <h4 className="type-display text-lg leading-tight text-[var(--starlight)]">{day.title}</h4>
      ) : null}
      {day.summary ? (
        <p className="type-body text-sm text-[var(--muted)]">{day.summary}</p>
      ) : null}
      {day.weather_summary ? (
        <p className="type-body mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
          {day.weather_source === 'open_meteo' ? (
            <span className="type-evidence rounded-[var(--radius-chip)] bg-[var(--chip-bg)] px-2 py-0.5 text-[10px] tracking-wide">
              <span className="font-semibold uppercase text-[var(--brass-bright)]">Weather</span>
            </span>
          ) : null}
          <span>{day.weather_summary}</span>
        </p>
      ) : null}
    </div>
  )
}
