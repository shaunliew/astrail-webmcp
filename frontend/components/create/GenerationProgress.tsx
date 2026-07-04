'use client'

import type { StreamEvent, GenerationStage } from '@/lib/trip/backend-types'

const STAGE_LABEL: Record<GenerationStage, string> = {
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

export default function GenerationProgress({ events }: { events: StreamEvent[] }) {
  return (
    <section data-testid="generation-progress" className="mx-auto flex w-full max-w-xl flex-col gap-4 p-6">
      <h1 className="type-display text-2xl text-[var(--starlight)]">Building your trip</h1>
      <p className="type-body text-sm text-[var(--muted)]">
        Astrail is turning your inspiration into a mapped route. Pins appear as places are verified.
      </p>

      {events.length === 0 ? (
        <p className="type-label text-xs uppercase tracking-wide text-[var(--faint)]">Starting…</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {events.map((event, i) => {
            if (event.type === 'heartbeat') {
              return (
                <li key={i} className="type-label pl-4 text-[10px] uppercase tracking-wide text-[var(--faint)]">
                  {event.elapsed_s.toFixed(1)}s elapsed
                </li>
              )
            }
            if (event.type === 'result') {
              return (
                <li key={i} className="type-body flex items-center gap-2 text-sm text-[var(--brass)]">
                  <span aria-hidden>✓</span> Trip ready — opening your trip…
                </li>
              )
            }
            const mapped = event.stage === 'dedup'
            return (
              <li key={i} className="surface flex flex-col gap-0.5 rounded-lg p-3">
                <span className={[
                  'type-label text-[10px] uppercase tracking-wide',
                  mapped ? 'text-[var(--brass)]' : 'text-[var(--muted)]',
                ].join(' ')}>
                  {STAGE_LABEL[event.stage]}
                </span>
                <span className="type-body text-sm text-[var(--starlight)]">{event.msg}</span>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
