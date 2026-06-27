'use client'

import type { StageEvent } from '@/lib/trip/backend-types'

const STAGE_LABELS: Record<StageEvent['stage'], string> = {
  scrape: 'Scraping Reels',
  cache_hit: 'Cache hit',
  extract: 'Extracting places',
  enrich: 'Researching places',
  weather: 'Fetching weather',
  restaurants: 'Finding restaurants',
  transport: 'Planning transport',
  narrate: 'Writing itinerary',
  summarize: 'Summarising',
}

type Props = {
  stages: StageEvent[]
  elapsed: number | null
  error: string | null
}

export default function GenerationTimeline({ stages, elapsed, error }: Props) {
  if (stages.length === 0 && !error) return null

  return (
    <div className="w-full max-w-xl flex flex-col gap-2">
      {stages.map((s, i) => (
        <div key={i} className="flex items-start gap-3">
          <span className="mt-0.5 w-1.5 h-1.5 rounded-full bg-[color:var(--starlight)]/40 shrink-0" />
          <div className="flex flex-col">
            <span className="text-xs font-medium text-[color:var(--starlight)]/70 font-[family-name:var(--font-geist)]">
              {STAGE_LABELS[s.stage] ?? s.stage}
            </span>
            <span className="text-xs text-[color:var(--starlight)]/40 font-[family-name:var(--font-geist)]">
              {s.msg}
            </span>
          </div>
        </div>
      ))}

      {elapsed !== null && (
        <p className="text-xs text-[color:var(--starlight)]/30 font-[family-name:var(--font-geist)] mt-1">
          {elapsed}s elapsed
        </p>
      )}

      {error && (
        <p className="text-xs text-red-400 font-[family-name:var(--font-geist)]">
          {error}
        </p>
      )}
    </div>
  )
}
