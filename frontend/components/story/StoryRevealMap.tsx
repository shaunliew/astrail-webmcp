'use client'

import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

import { LANDING_DEMO_STOPS } from '@/lib/trip/fixtures/landing-demo-stops'

/* The Beat-6 payoff: the REAL product map (not a render). A standalone,
   non-interactive Mapbox instance — its own WebGL context, no MapProvider
   coupling — showing a real generated trip's stops: numbered constellation
   pins joined by the brass route line, night preset, exactly the app's look. */

const STOPS = [...LANDING_DEMO_STOPS].sort(
  (a, b) => a.day - b.day || a.order - b.order,
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

    // Construction succeeding doesn't mean the map arrives — a revoked token or a
    // blocked api.mapbox.com fails async. Any error before the style has loaded
    // means the reveal will never render: fall back instead of an empty dark frame.
    let styleLoaded = false
    map.on('error', () => {
      if (!styleLoaded) setFailed(true)
    })

    map.on('style.load', () => {
      styleLoaded = true
      map.setConfigProperty('basemap', 'lightPreset', 'night')

      // Style defaults on purpose: POI / transit / road labels all render, so
      // the night map reads as a living city rather than an empty dark frame.

      // Brass route line through the ordered stops (the flight-trail, landed).
      const coordinates = STOPS.map((s) => [s.lng, s.lat])
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

    // Numbered constellation pins (globals.css already styles these), each with an
    // always-visible place card — this map is non-interactive, so a bare number
    // would leave landing visitors guessing what the stop is. Cards face inward
    // (east pins label left, west pins label right) to stay in frame.
    const lngs = STOPS.map((s) => s.lng)
    const centerLng = (Math.min(...lngs) + Math.max(...lngs)) / 2
    const markers = STOPS.map((s, i) => {
      const el = document.createElement('div')
      el.className = 'constellation-pin'
      el.textContent = String(i + 1)

      const side = s.lng > centerLng ? 'left' : 'right'
      const card = document.createElement('div')
      card.className = `constellation-pin-card constellation-pin-card--${side}`
      const day = document.createElement('span')
      day.className = 'constellation-pin-card__day'
      day.textContent = `Day ${s.day}`
      const name = document.createElement('span')
      name.className = 'constellation-pin-card__name'
      name.textContent = s.name
      card.append(day, name)
      el.appendChild(card)

      return new mapboxgl.Marker({ element: el })
        .setLngLat([s.lng, s.lat])
        .addTo(map)
    })

    const bounds = new mapboxgl.LngLatBounds()
    STOPS.forEach((s) => bounds.extend([s.lng, s.lat]))
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
      role="img"
      aria-label="Live Astrail itinerary map — Tokyo demo trip"
    />
  )
}
