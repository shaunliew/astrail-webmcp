'use client'

import { useEffect, useRef, useState } from 'react'
import type { StreamEvent, GenerationStage } from '@/lib/trip/backend-types'
import { readResultVerdict } from '@/lib/webmcp/generation'
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
  enrich: 'Research',
  restaurants: 'Research',
  hotels: 'Travala',
  transport: 'Mapbox',
}

/**
 * The provenance chip for one stage row. Static per stage EXCEPT `preferences`, which is the
 * one stage whose source is decided at RUNTIME: it fires for remembered mem0 facts, for
 * preferences the user typed this trip, and for neither (pipeline/preferences.py:60-70).
 *
 * It used to sit in STAGE_SOURCE as a flat `preferences: 'Memory'`, so the chip read "Memory"
 * on all three branches — including "No preferences provided", where mem0 returned nothing and
 * the label was simply false. That is a claim on the judged surface, and it already misled a
 * reader of this repo into believing recall had run when it had not.
 *
 * So the chip now reads the backend's own `preference_source` and shows NOTHING unless memory
 * genuinely supplied the facts. An absent payload is treated as "not memory": a chip that is
 * missing costs a little emphasis, a chip that is wrong costs the claim.
 */
function sourceChip(
  // Structural, not `StageEvent`: at the call site TypeScript still holds `StageEvent |
  // NoticeEvent` (NoticeEvent's discriminant is itself a three-way union and does not fully
  // narrow away). The old `STAGE_SOURCE[event.stage]` compiled on that union by accident —
  // both carry `stage`. This asks for exactly what it reads and stays honest about it.
  event: { stage: GenerationStage; content?: Record<string, unknown> | null },
): string | undefined {
  if (event.stage !== 'preferences') return STAGE_SOURCE[event.stage]
  const source = (event.content as { preference_source?: unknown } | null | undefined)?.preference_source
  return source === 'memory' ? 'Memory' : undefined
}

function formatElapsed(totalSeconds: number): string {
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`
}

/**
 * Seconds this screen has been waiting, ticking once a second while `running`.
 *
 * A measured wait, and the only number on this screen that is allowed to move on its own — the
 * genbar deliberately does NOT, because a bar advancing on a timer would be inventing progress on
 * a product whose whole pitch is not inventing things. It is also the liveness signal that
 * survives `prefers-reduced-motion`, where every animation on this screen is switched off.
 *
 * Anchored at mount rather than at a run-start timestamp because there isn't one: the shell's run
 * record carries no start time, and this component mounts exactly when the user commits to
 * generating (the phase flips before the POST returns). So it measures the wait the user is
 * actually sitting through, which is the thing they asked about, and it slightly over-counts the
 * backend run by the POST round-trip rather than under-counting the wait.
 *
 * Freezing on `running` going false is the point: a clock still running on a finished trip is the
 * same lie as a pulse on a finished trip.
 */
function useElapsedSeconds(running: boolean): number {
  const startedAt = useRef<number | null>(null)
  if (startedAt.current === null) startedAt.current = Date.now()
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!running) return
    const tick = () => setElapsed(Math.floor((Date.now() - (startedAt.current as number)) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [running])

  return elapsed
}

export default function GenerationProgress({ events }: { events: StreamEvent[] }) {
  /**
   * Settled and SUCCEEDED are two different questions, and this screen used to ask only the first.
   *
   * A leased failure terminates the stream with a `result` frame like any other run — the payload
   * carries `{error: …}` instead of `{itinerary: …}` (pipeline/runner.py → api/streaming.py). So
   * `events.some(type === 'result')` was true on a failure too, and this screen printed "Your trip
   * is ready" over it. Not hypothetically: the page's failure-recovery effect only returns the
   * user to the brief AFTER paint, so a failed run flashed a success headline first — the worst
   * frame this product can draw, on the one screen whose entire pitch is not inventing things.
   *
   * `readResultVerdict` is the single rule for this, deliberately reused rather than re-derived:
   * it keys on the PRESENCE of the `error` key, so `{"error": null}` — a failure that lost its
   * message — is still a failure, and a payload it cannot read is reported as neither.
   */
  const verdict = (() => {
    const result = events.find((e): e is Extract<StreamEvent, { type: 'result' }> => e.type === 'result')
    return result ? readResultVerdict(result.content) : null
  })()
  // The run is over whichever way it went, so the clock stops and the trail stops flowing. A
  // pulse on a finished run is motion telling a lie (DESIGN.md §5) — and so is one on a dead run.
  const settled = verdict !== null
  const succeeded = verdict === 'success'
  const elapsed = useElapsedSeconds(!settled)

  // The newest DISPATCHED stage — not the newest event, which is often a warning or a decision
  // about work that has already finished. `STAGE_LABEL` can miss for a stage a newer backend
  // emits that this build has never heard of, hence the fallback.
  const currentStage = events.reduce<GenerationStage | null>(
    (latest, e) => (e.type === 'stage' ? e.stage : latest), null,
  )
  /**
   * Three endings, three sentences. The middle one is the one that was missing.
   *
   * `unreadable` gets its own wording rather than being folded into failure, for the reason
   * `readResultVerdict` keeps it separate: a payload we could not parse is not evidence the trip
   * died, and telling someone their trip failed is how they end up paying to generate a trip they
   * already have.
   */
  const heading = succeeded ? 'Your trip is ready'
    : verdict === 'failed' ? 'Your trip didn’t finish'
    : verdict === 'unreadable' ? 'This run has stopped'
    : 'Building your trip'
  const nowLine = succeeded ? 'Trip ready — opening your trip…'
    : verdict === 'failed' ? 'Something went wrong — taking you back.'
    : verdict === 'unreadable' ? 'Astrail could not read the final result — check your trips.'
    : currentStage ? STAGE_LABEL[currentStage] ?? 'Working on your trip'
    : 'Starting…'

  return (
    <section data-testid="generation-progress" className="flex w-full flex-col gap-5 text-[color:var(--text)]">
      {/* Pinned to the top of the sheet, which is the scroll container (GenerationScene owns the
          overflow). Without this the header and the now-line scroll away behind the trail after
          about a dozen events, which on a 3-minute run is the first thirty seconds — and then
          the always-visible working state is not visible at all. Opaque, so the trail passes
          underneath it rather than through it. */}
      <div
        data-testid="generation-header"
        className="sticky top-0 z-10 flex flex-col gap-4 bg-[color:var(--surface-1)] pb-3"
      >
        <div className="flex items-center gap-3">
          <Astronaut size={40} variant={settled ? 'idle' : 'waiting'} />
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Building your trail</p>
            <h1 className="font-display text-[22px] font-medium leading-[1.18] tracking-[-0.015em]" style={{ fontVariationSettings: "'SOFT' 28, 'WONK' 1, 'opsz' 22" }}>
              {heading}
            </h1>
          </div>
        </div>

        {/* The one line that never scrolls away.
            The trail below outgrows the height of this sheet during the concurrent tail, so the
            newest line spends most of a real run below the fold — leaving a screen where nothing
            visibly changes for over two minutes, which is exactly how a working run gets read as a
            hung one. This says what is happening now and how long it has been going, at a fixed
            place on screen. The clock sits OUTSIDE the live region on purpose: announcing a new
            time every second would bury the stage changes that actually carry meaning. */}
        <div
          data-testid="generation-now"
          className="flex items-center gap-2.5 rounded-xl border border-[color:var(--paper-line)] bg-[color:var(--surface-2)] px-3 py-2.5"
        >
          <span
            aria-hidden
            data-testid="generation-live-dot"
            className={`pulse-dot ${succeeded ? 'pulse-dot--ok' : verdict === 'failed' ? 'pulse-dot--fail' : verdict === 'unreadable' ? 'pulse-dot--warn' : 'pulse-dot--live'}`}
          />
          <span role="status" aria-live="polite" className="min-w-0 flex-1 truncate text-[13px] font-medium">
            {nowLine}
          </span>
          <span
            data-testid="generation-elapsed"
            className="flex-none font-mono text-[11px] tabular-nums text-[color:var(--text-muted)]"
          >
            {formatElapsed(elapsed)} elapsed
          </span>
        </div>
      </div>

      {events.length === 0 ? null : (
        <ol className="flex flex-col">
          {events.map((event, i) => {
            if (event.type === 'heartbeat') {
              return (
                <li key={i} className="py-1 pl-5 font-mono text-[11px] tabular-nums text-[color:var(--text-faint)]">
                  {event.elapsed_s.toFixed(1)}s elapsed
                </li>
              )
            }
            // The result is announced by the now-line above, which is always on screen — a
            // second copy at the bottom of a list the user has scrolled away from is where the
            // arrival was getting lost.
            if (event.type === 'result') return null
            if (event.type === 'warning' || event.type === 'error' || event.type === 'decision') {
              return (
                <li key={i} className="flex items-start gap-2.5 py-1.5 text-[13px] text-[color:var(--text-muted)]">
                  <span aria-hidden className="mt-1.5 h-2 w-2 flex-none rounded-full border border-[color:var(--ink-400)] bg-[color:var(--surface-1)]" />
                  <span>{event.msg}</span>
                </li>
              )
            }
            const current = i === events.length - 1
            const src = sourceChip(event)
            return (
              <li key={i} className="flex items-start gap-2.5 py-1.5">
                <span
                  aria-hidden
                  className={`mt-1.5 h-2 w-2 flex-none rounded-full ${current && !settled ? 'pulse-dot pulse-dot--live bg-[color:var(--brass-deep)]' : current ? 'pulse-dot bg-[color:var(--brass-deep)]' : 'bg-[color:var(--ink-900)]'}`}
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
