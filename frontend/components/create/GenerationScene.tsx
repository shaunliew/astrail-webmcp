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
import type { StreamEvent } from '@/lib/trip/backend-types'
import { useSharedMap } from '@/components/map/MapProvider'
import GenerationProgress from './GenerationProgress'

// Stages that only run after places are persisted (progressive persistence, PRD §16) —
// the earliest safe moments to read trip_places and land pins.
const PLACES_READY_STAGES = new Set([
  'dedup', 'enrich', 'weather', 'restaurants', 'hotels', 'transport', 'narrate', 'summarize',
])

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
    <main className="relative min-h-[100dvh] overflow-hidden">
      {/* The map itself is the shell's fixed layer behind this route; only the
          no-token fallback needs painting here. */}
      {hasToken ? null : <div aria-hidden className="hero-field absolute inset-0" />}
      {/* Readability scrim: night sky stays visible, the rail stays legible. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(10,11,20,0.9),rgba(10,11,20,0.5)_44%,transparent_72%)]"
      />
      <div className="relative z-10 flex min-h-[100dvh] w-full max-w-lg flex-col justify-center p-6">
        <div className="surface p-6">
          <GenerationProgress events={events} />
        </div>
      </div>
    </main>
  )
}
