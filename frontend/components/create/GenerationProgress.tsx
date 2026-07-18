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
    <section data-testid="generation-progress" className="flex w-full flex-col gap-4">
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
            if (event.type === 'warning' || event.type === 'error' || event.type === 'decision') {
              return (
                <li key={i} className="type-body flex items-start gap-2 pl-4 text-sm text-[var(--muted)]">
                  <span aria-hidden>{event.type === 'decision' ? '·' : '⚠'}</span>
                  <span>{event.msg}</span>
                </li>
              )
            }
            const mapped = event.stage === 'dedup'
            const current = i === events.length - 1
            return (
              <li
                key={i}
                className={[
                  'flex flex-col gap-0.5 rounded-lg border px-3 py-2.5',
                  current
                    ? 'border-[rgba(201,151,78,0.3)] bg-[var(--brass-soft)] shadow-[0_0_14px_var(--brass-glow)]'
                    : 'border-transparent bg-[rgba(247,243,232,0.04)]',
                ].join(' ')}
              >
                <span className={[
                  'type-label flex items-center gap-1.5 text-[10px] uppercase tracking-wide',
                  mapped || current ? 'text-[var(--brass-bright)]' : 'text-[var(--muted)]',
                ].join(' ')}>
                  {current ? <span aria-hidden className="pulse-dot" /> : null}
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
