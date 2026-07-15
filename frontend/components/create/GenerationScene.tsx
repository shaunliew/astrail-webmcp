'use client'

// The launch: a Night-world map behind the generation rail. Pins land the moment a
// places-bearing stage fires (PRD §16 — time to first mapped value beats time to done).
// The map is progressive enhancement: without a token (tests, missing env) the rail
// still narrates over the starfield and nothing fetches.
import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { getTrip } from '@/lib/trip/supabase-api'
import type { StreamEvent } from '@/lib/trip/backend-types'
import GenerationProgress from './GenerationProgress'

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN

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
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const markersRef = useRef<mapboxgl.Marker[]>([])
  const fetchedRef = useRef(false)

  const placesReady = events.some(
    (e) => e.type === 'stage' && PLACES_READY_STAGES.has(e.stage),
  )

  // Night globe backdrop.
  useEffect(() => {
    if (!TOKEN || !containerRef.current || mapRef.current) return
    mapboxgl.accessToken = TOKEN
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/standard',
      projection: 'globe',
      center: [100, 15], // wide-open globe until the first verified places arrive
      zoom: 1.2,
      pitch: 0,
      interactive: false,
    })
    map.on('load', () => map.setConfigProperty('basemap', 'lightPreset', 'night'))
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
      markersRef.current = []
    }
  }, [])

  // First mapped value: fetch the progressively-persisted places once and land them.
  useEffect(() => {
    if (!TOKEN || !tripId || !placesReady || fetchedRef.current) return
    fetchedRef.current = true
    let cancelled = false
    ;(async () => {
      try {
        const bundle = await getTrip(tripId)
        const map = mapRef.current
        if (cancelled || !bundle || !map || bundle.places.length === 0) return
        const bounds = new mapboxgl.LngLatBounds()
        bundle.places.forEach((tp, i) => {
          const el = document.createElement('div')
          el.className = 'pin-land'
          el.style.animationDelay = `${600 + i * 220}ms` // land while the camera dives
          const marker = new mapboxgl.Marker({ element: el })
            .setLngLat([tp.place.lng, tp.place.lat])
            .addTo(map)
          markersRef.current.push(marker)
          bounds.extend([tp.place.lng, tp.place.lat])
        })
        map.fitBounds(bounds, { padding: 120, maxZoom: 11.5, pitch: 45, duration: 3200, essential: true })
      } catch {
        // Pins mid-generation are a bonus — the rail still narrates every stage,
        // and the trip page renders the full map after the result event.
      }
    })()
    return () => { cancelled = true }
  }, [tripId, placesReady])

  return (
    <main className="relative min-h-[100dvh] overflow-hidden">
      {TOKEN ? (
        <div ref={containerRef} aria-hidden className="absolute inset-0" />
      ) : (
        <div aria-hidden className="hero-field absolute inset-0" />
      )}
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
