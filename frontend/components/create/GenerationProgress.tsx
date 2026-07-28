'use client'

import type { StreamEvent, GenerationStage } from '@/lib/trip/backend-types'
import Astronaut from '@/components/mascot/Astronaut'

// The canonical stage->English map (DESIGN.md §8) — AgentDecisionRail reuses it.
export const STAGE_LABEL: Record<GenerationStage, string> = {
  create_trip: 'Creating your trip',
  scrape: 'Scraping Reels',
  cache_hit: 'Using cached Reel',
  extract: 'Extracting places',
  resolve: 'Resolving your requests',
  preferences: 'Applying preferences',
  dedup: 'Mapping verified places',
  enrich: 'Enriching places',
  weather: 'Checking weather',
  restaurants: 'Finding restaurants',
  hotels: 'Searching hotels',
  transport: 'Planning routes',
  narrate: 'Writing your days',
  summarize: 'Summarizing',
  save: 'Saving trip',
}

// Provenance: which tool produced each line — the evidence-chip idea applied to progress
// (DESIGN.md §6). Mono, because it names a source. Stages without a clear tool show no chip.
const STAGE_SOURCE: Partial<Record<GenerationStage, string>> = {
  scrape: 'Apify',
  resolve: 'Mapbox',
  preferences: 'Memory',
  enrich: 'Research',
  restaurants: 'Research',
  hotels: 'Travala',
  transport: 'Mapbox',
}

export default function GenerationProgress({ events }: { events: StreamEvent[] }) {
  // Waiting is the only live state: once the result event lands, the trail stops flowing —
  // a pulse on a finished run is motion telling a lie (DESIGN.md §5).
  const done = events.some((e) => e.type === 'result')

  return (
    <section data-testid="generation-progress" className="flex w-full flex-col gap-5 text-[color:var(--text)]">
      <div className="flex items-center gap-3">
        <Astronaut size={40} variant={done ? 'idle' : 'waiting'} />
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Building your trail</p>
          <h1 className="font-display text-[22px] font-medium leading-[1.18] tracking-[-0.015em]" style={{ fontVariationSettings: "'SOFT' 28, 'WONK' 1, 'opsz' 22" }}>
            Building your trip
          </h1>
        </div>
      </div>

      {events.length === 0 ? (
        <p className="text-[13px] text-[color:var(--text-muted)]">Starting…</p>
      ) : (
        <ol className="flex flex-col">
          {events.map((event, i) => {
            if (event.type === 'heartbeat') {
              return (
                <li key={i} className="py-1 pl-5 font-mono text-[11px] tabular-nums text-[color:var(--text-faint)]">
                  {event.elapsed_s.toFixed(1)}s elapsed
                </li>
              )
            }
            if (event.type === 'result') {
              return (
                <li key={i} className="flex items-center gap-2 py-1.5 text-[14px] font-medium text-[color:var(--brass-deep)]">
                  <span aria-hidden className="h-2 w-2 flex-none rounded-full bg-[color:var(--brass-deep)]" /> Trip ready — opening your trip…
                </li>
              )
            }
            if (event.type === 'warning' || event.type === 'error' || event.type === 'decision') {
              return (
                <li key={i} className="flex items-start gap-2.5 py-1.5 text-[13px] text-[color:var(--text-muted)]">
                  <span aria-hidden className="mt-1.5 h-2 w-2 flex-none rounded-full border border-[color:var(--ink-400)] bg-[color:var(--surface-1)]" />
                  <span>{event.msg}</span>
                </li>
              )
            }
            const current = i === events.length - 1
            const src = STAGE_SOURCE[event.stage]
            return (
              <li key={i} className="flex items-start gap-2.5 py-1.5">
                <span
                  aria-hidden
                  className={`mt-1.5 h-2 w-2 flex-none rounded-full ${current ? 'pulse-dot bg-[color:var(--brass-deep)]' : 'bg-[color:var(--ink-900)]'}`}
                />
                <span className="min-w-0 flex-1">
                  <span className={`block text-[11px] font-semibold uppercase tracking-wide ${current ? 'text-[color:var(--brass-deep)]' : 'text-[color:var(--text-muted)]'}`}>
                    {STAGE_LABEL[event.stage]}
                  </span>
                  <span className="block text-[14px] text-[color:var(--text)]">
                    {event.msg}
                    {src ? <span className="ml-2 font-mono text-[11px] text-[color:var(--brass-deep)]">{src}</span> : null}
                  </span>
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
