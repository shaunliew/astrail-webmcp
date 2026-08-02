'use client'

import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

import { TOKYO_TRIP } from '@/lib/trip/fixtures/tokyo-trip'

/* The Beat-6 payoff: the REAL product map (not a render). A standalone,
   non-interactive Mapbox instance — its own WebGL context, no MapProvider
   coupling — showing the Tokyo demo trip: numbered constellation pins joined
   by the brass route line, night preset, exactly the app's look. */

const STOPS = TOKYO_TRIP.places
  .filter((tp) => tp.day_number != null && tp.place)
  .sort(
    (a, b) =>
      (a.day_number ?? 0) - (b.day_number ?? 0) ||
      (a.sort_order ?? 0) - (b.sort_order ?? 0),
  )

export default function StoryRevealMap({ className }: { className?: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const token = process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!token || !containerRef.current || mapRef.current) return

    mapboxgl.accessToken = token
    let map: mapboxgl.Map
    try {
      map = new mapboxgl.Map({
        container: containerRef.current,
        style: 'mapbox://styles/mapbox/standard',
        projection: 'globe',
        center: [139.77, 35.68],
        zoom: 10,
        pitch: 32,
        interactive: false, // a reveal, not a workspace — never hijack the page scroll
      })
    } catch {
      setFailed(true)
      return
    }
    mapRef.current = map

    map.on('style.load', () => {
      map.setConfigProperty('basemap', 'lightPreset', 'night')

      // Brass route line through the ordered stops (the flight-trail, landed).
      const coordinates = STOPS.map((tp) => [tp.place!.lng, tp.place!.lat])
      map.addSource('story-route', {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates },
        },
      })
      map.addLayer({
        id: 'story-route-casing',
        type: 'line',
        source: 'story-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#C9974E', 'line-width': 6, 'line-opacity': 0.28 },
      })
      map.addLayer({
        id: 'story-route-core',
        type: 'line',
        source: 'story-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#E8B667',
          'line-width': 2.2,
          'line-dasharray': [2.2, 1.6],
        },
      })
    })

    // Numbered constellation pins (globals.css already styles these).
    const markers = STOPS.map((tp, i) => {
      const el = document.createElement('div')
      el.className = 'constellation-pin'
      el.textContent = String(i + 1)
      return new mapboxgl.Marker({ element: el })
        .setLngLat([tp.place!.lng, tp.place!.lat])
        .addTo(map)
    })

    const bounds = new mapboxgl.LngLatBounds()
    STOPS.forEach((tp) => bounds.extend([tp.place!.lng, tp.place!.lat]))
    map.fitBounds(bounds, { padding: 96, duration: 0 })

    const resizeObserver = new ResizeObserver(() => mapRef.current?.resize())
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      markers.forEach((m) => m.remove())
      map.remove()
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!token || failed) {
    // Reduced-capability fallback: the story still resolves on a static frame.
    return (
      <div
        className={`${className ?? ''} flex items-center justify-center bg-[color:var(--night-900)]`}
        role="img"
        aria-label="The Astrail itinerary map"
      >
        <p className="font-mono text-xs uppercase tracking-wide text-[color:var(--starlight-50)]">
          A real itinerary on a real map
        </p>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className={className}
      aria-label="Live Astrail itinerary map — Tokyo demo trip"
    />
  )
}
