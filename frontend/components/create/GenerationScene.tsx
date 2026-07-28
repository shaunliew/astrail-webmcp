'use client'

// The launch: a Night-world map behind the generation rail. Pins land the moment a
// places-bearing stage fires (PRD §16 — time to first mapped value beats time to done).
//
// The map is the shell's shared instance (components/map/MapProvider), not one of our
// own: it has to outlive this component so the night->dawn relight can run on a live map
// across the handoff to the trip workspace. The map stays progressive enhancement —
// without a token (tests, missing env) the rail still narrates over the starfield.
import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import { getTrip } from '@/lib/trip/supabase-api'
import type { StreamEvent, GenerationStage } from '@/lib/trip/backend-types'
import { useSharedMap } from '@/components/map/MapProvider'
import GenerationProgress from './GenerationProgress'

// Stages that only run after places are persisted (progressive persistence, PRD §16) —
// the earliest safe moments to read trip_places and land pins.
const PLACES_READY_STAGES = new Set([
  'dedup', 'enrich', 'weather', 'restaurants', 'hotels', 'transport', 'narrate', 'summarize',
])

// Pipeline order → a rough progress signal for the genbar. Progress is indeterminate
// (DESIGN.md) — this is a gesture of forward motion by stage, not a real percentage.
const STAGE_ORDER: GenerationStage[] = [
  'create_trip', 'scrape', 'cache_hit', 'extract', 'resolve', 'preferences', 'dedup',
  'enrich', 'weather', 'restaurants', 'hotels', 'transport', 'narrate', 'summarize', 'save',
]

export default function GenerationScene({
  tripId, events,
}: {
  tripId: string | null
  events: StreamEvent[]
}) {
  const { hasToken, ready, getMap, acquire, release, setMarkers } = useSharedMap()
  const fetchedRef = useRef(false)

  const placesReady = events.some(
    (e) => e.type === 'stage' && PLACES_READY_STAGES.has(e.stage),
  )

  const done = events.some((e) => e.type === 'result')
  const lastStage = [...events].reverse().find((e): e is Extract<StreamEvent, { type: 'stage' }> => e.type === 'stage')?.stage
  const progress = done ? 100 : lastStage ? Math.round(((STAGE_ORDER.indexOf(lastStage) + 1) / STAGE_ORDER.length) * 100) : 5

  // Night globe backdrop. Inert: this scene is a backdrop, not something to fly around.
  useEffect(() => {
    acquire({ interactive: false, lightPreset: 'night', center: [100, 15], zoom: 1.2 })
    return () => release()
  }, [acquire, release])

  // First mapped value: fetch the progressively-persisted places once and land them.
  useEffect(() => {
    if (!ready || !tripId || !placesReady || fetchedRef.current) return
    fetchedRef.current = true
    let cancelled = false
    ;(async () => {
      try {
        const bundle = await getTrip(tripId)
        const map = getMap()
        if (cancelled || !bundle || !map || bundle.places.length === 0) return
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
      }
    })()
    return () => { cancelled = true }
  }, [ready, tripId, placesReady, getMap, setMarkers])

  return (
    <main className="relative min-h-[100dvh] overflow-hidden bg-[color:var(--night-900)]">
      {/* Top progress genbar — striped brass, advancing by stage. */}
      <div className="absolute inset-x-0 top-0 z-30 h-1 bg-[color:var(--night-800)]">
        <div
          className="h-full bg-[repeating-linear-gradient(-45deg,var(--brass-deep)_0_8px,transparent_8px_16px)] transition-[width] duration-500"
          style={{ width: `${progress}%` }}
        />
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
