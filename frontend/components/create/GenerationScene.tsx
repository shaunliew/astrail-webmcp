'use client'

// The launch: a Night-world map behind the generation rail. Pins land the moment a
// places-bearing stage fires (PRD §16 — time to first mapped value beats time to done).
//
// The map is the shell's shared instance (components/map/MapProvider), not one of our
// own: it has to outlive this component so the night->dawn relight can run on a live map
// across the handoff to the trip workspace. The map stays progressive enhancement —
// without a token (tests, missing env) the rail still narrates over the starfield.
import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import { getTrip } from '@/lib/trip/supabase-api'
import type { StreamEvent, GenerationStage } from '@/lib/trip/backend-types'
import { useSharedMap } from '@/components/map/MapProvider'
import GenerationProgress from './GenerationProgress'

// Stages after which the persisted places MIGHT be readable. Deliberately "might": `dedup` is
// emitted at runner.py:332 and persist_itinerary does not run until :391 — even `stage:save`
// (:386) precedes it — so none of these actually proves a row exists. They are kept as a fallback
// for a backend that predates the post-persistence `decision` on `save`, which is the only signal
// that MEANS it. The fetch below therefore retries rather than trusting any one of them.
const PLACES_READY_STAGES = new Set([
  'dedup', 'enrich', 'weather', 'restaurants', 'hotels', 'transport', 'narrate', 'summarize',
])

// Pipeline order → a real position for the genbar, but ONLY for the sequential half of the run
// (see CONCURRENT_TAIL below). This is the furthest stage STARTED, never percent-complete.
const STAGE_ORDER: GenerationStage[] = [
  'create_trip', 'scrape', 'cache_hit', 'extract', 'resolve', 'preferences', 'dedup',
  'enrich', 'weather', 'restaurants', 'hotels', 'transport', 'narrate', 'summarize', 'save',
]

// Where an honest percentage stops existing. runner.py runs the pipeline sequentially as far as
// `save` (:386) and then gathers save+transport+restaurants+hotels+summarize, each recording its
// `stage` event as its first statement — so all five dispatch within milliseconds and then take
// ~140s, the bulk of the whole run. Advancing on the furthest dispatch therefore reached
// summarize (index 13 of 15) in the first seconds and pinned at 93% for the rest, which a real
// user read as a hung page. A number nobody can back is worse than no number: once any of these
// has dispatched the bar stops claiming a percentage and goes indeterminate.
//
// Membership is by DISPATCH (`stage`), never by completion (`decision`): a decision reports
// finished work, and one arriving early for a tail stage would flip the bar off a position the
// sequential pipeline can still legitimately advance.
const CONCURRENT_TAIL = new Set<GenerationStage>([
  'save', 'transport', 'restaurants', 'hotels', 'summarize',
])

export default function GenerationScene({
  tripId, events,
}: {
  tripId: string | null
  events: StreamEvent[]
}) {
  const { hasToken, ready, getMap, acquire, release, setMarkers } = useSharedMap()
  const fetchedRef = useRef(false)
  const inFlightRef = useRef(false)
  // The retry that survives an OVERLAPPING signal, and it is state rather than a ref for the
  // one reason that matters: changing a ref neither renders nor re-runs an effect. `inFlightRef`
  // clearing in the `finally` below therefore scheduled nothing, so a signal that arrived while
  // a read was open was dropped for good — and that overlap is the ordinary case, not a rare
  // race: runner.py writes the post-persistence `decision:save` and then dispatches transport,
  // restaurants, hotels and summarize within milliseconds, every one of them landing while the
  // save-triggered read is still in flight. Bumping this is what wakes the effect to try again.
  const [retryTick, setRetryTick] = useState(0)

  // A COUNT, not a boolean: a boolean flips true once and the effect never runs again, so one
  // too-early read was the only read that ever happened. Counting lets each later signal retry.
  const placesSignals = events.filter(
    (e) => (e.type === 'decision' && e.stage === 'save')
      || (e.type === 'stage' && PLACES_READY_STAGES.has(e.stage)),
  ).length

  const done = events.some((e) => e.type === 'result')
  // FURTHEST stage DISPATCHED, not the most recent event. The late stages are gathered
  // concurrently and each records its `stage` event before doing any work, so the dispatches
  // themselves arrive out of STAGE_ORDER — transport (index 11) is emitted before restaurants
  // (index 9). Reading the last event verbatim rewinds the bar, and a bar going backwards reads
  // as lost ground. indexOf returns -1 for a stage this build does not know; Math.max ignores it.
  //
  // Completions are `decision` events and are filtered out here on purpose: they report finished
  // work, not a new pipeline position.
  const furthestStage = events.reduce(
    (max, e) => (e.type === 'stage' ? Math.max(max, STAGE_ORDER.indexOf(e.stage)) : max),
    -1,
  )
  // A latch on the events themselves, not on `furthestStage`: the max index can be a SEQUENTIAL
  // stage (narrate, 12) that outranks a tail stage already dispatched (restaurants, 9), so asking
  // whether the furthest position is in the tail would miss the tail entirely.
  const inConcurrentTail = events.some((e) => e.type === 'stage' && CONCURRENT_TAIL.has(e.stage))
  const indeterminate = !done && inConcurrentTail
  const progress = done ? 100
    : furthestStage >= 0 ? Math.round(((furthestStage + 1) / STAGE_ORDER.length) * 100)
    : 5

  // Night globe backdrop. Inert: this scene is a backdrop, not something to fly around.
  useEffect(() => {
    acquire({ interactive: false, lightPreset: 'night', center: [100, 15], zoom: 1.4 })
    return () => release()
  }, [acquire, release])

  // First mapped value: land the progressively-persisted places as soon as they exist.
  //
  // The latch is set AFTER pins land, never before the read. Setting it up front — which is what
  // this did — meant an empty early read permanently suppressed every retry, and the pins never
  // appeared at all during a real generation. `inFlightRef` keeps the retries from overlapping
  // now that more than one signal can trigger this, and `retryTick` reschedules the one that
  // arrived while a read was open (see the `finally`).
  useEffect(() => {
    if (!ready || !tripId || placesSignals === 0 || fetchedRef.current || inFlightRef.current) return
    inFlightRef.current = true
    let cancelled = false
    ;(async () => {
      try {
        const bundle = await getTrip(tripId)
        const map = getMap()
        if (cancelled || !bundle || !map || bundle.places.length === 0) return
        fetchedRef.current = true
        const bounds = new mapboxgl.LngLatBounds()
        const markers = bundle.places.map((tp, i) => {
          const el = document.createElement('div')
          el.className = 'pin-land'
          el.style.animationDelay = `${600 + i * 220}ms` // land while the camera dives
          bounds.extend([tp.place.lng, tp.place.lat])
          return new mapboxgl.Marker({ element: el })
            .setLngLat([tp.place.lng, tp.place.lat])
            .addTo(map)
        })
        // Handed to the provider so they are torn down on the way out and can never
        // accumulate on the shared instance across repeat generations.
        setMarkers(markers)
        map.fitBounds(bounds, { padding: 120, maxZoom: 11.5, pitch: 45, duration: 3200, essential: true })
      } catch {
        // Pins mid-generation are a bonus — the rail still narrates every stage,
        // and the trip page renders the full map after the result event.
      } finally {
        inFlightRef.current = false
        // An attempt is only ever cancelled by React running this effect's cleanup, which
        // happens for exactly two reasons: a dep changed (a NEW signal, overwhelmingly) or the
        // component went away. It applied nothing either way, so unless the pins are already
        // down another attempt is owed — and the effect run that would have made it returned
        // early on `inFlightRef`. Bumping state is what schedules it; on the unmount reason the
        // update is a no-op and the re-run, if any, returns at the guards above. The cancelled
        // read's bundle is re-fetched rather than salvaged — one extra read of one trip, and the
        // price of not having to tell "a signal arrived" apart from "we are gone" in a cleanup.
        if (cancelled && !fetchedRef.current) setRetryTick((tick) => tick + 1)
      }
    })()
    return () => { cancelled = true }
  }, [ready, tripId, placesSignals, retryTick, getMap, setMarkers])

  return (
    <main className="relative min-h-[100dvh] overflow-hidden">
      {/* Dark base behind the shared map (fixed, z-0): keeps the space backdrop while the
          dawn globe fades in and covers the no-token / still-loading moment — main itself
          stays transparent so the globe shows through (see comment below). */}
      <div aria-hidden className="fixed inset-0 -z-10 bg-[color:var(--night-900)]" />
      {/* Top progress genbar. Solid brass, never diagonal stripes: the stripes read as
          construction tape to the first user who waited out a real run. It shows a percentage
          only while that percentage is real, and announces itself as a progressbar so what it
          means does not depend on recognising the shape — an indeterminate progressbar is
          precisely one with no aria-valuenow, so the omission below is the semantic, not a gap. */}
      <div
        data-testid="genbar"
        role="progressbar"
        aria-label="Building your trip"
        aria-valuemin={0}
        aria-valuemax={100}
        {...(indeterminate
          ? { 'aria-valuetext': 'Working — this part takes a couple of minutes', 'data-indeterminate': 'true' }
          : { 'aria-valuenow': progress })}
        className="absolute inset-x-0 top-0 z-30 h-[3px] overflow-hidden bg-[color:var(--night-800)]"
      >
        {indeterminate ? (
          <div data-testid="genbar-sweep" aria-hidden className="genbar-sweep h-full" />
        ) : (
          <div
            data-testid="genbar-fill"
            aria-hidden
            className={`genbar-fill h-full ${done ? '' : 'genbar-fill--live'}`}
            style={{ width: `${progress}%` }}
          />
        )}
      </div>

      {/* The map is the shell's fixed layer behind this route; only the no-token
          fallback needs painting here. */}
      {hasToken ? null : <div aria-hidden className="hero-field absolute inset-0" />}

      {/* Narration rail — a paper sheet over the night map (left rail on desktop,
          bottom sheet on mobile), the same shell language as the tray/plan. */}
      <section className="absolute z-20 flex flex-col overflow-y-auto rounded-t-2xl border border-[color:var(--paper-line-2)] bg-[color:var(--surface-1)] p-6 shadow-[0_1px_2px_rgba(28,23,16,0.10),0_-10px_44px_rgba(0,0,0,0.4)] inset-x-0 bottom-0 max-h-[64dvh] md:inset-x-auto md:left-4 md:top-4 md:bottom-4 md:max-h-none md:w-[420px] md:rounded-2xl">
        <GenerationProgress events={events} />
      </section>
    </main>
  )
}
