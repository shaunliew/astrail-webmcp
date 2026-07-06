'use client'

import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import type { TripBundle, PlaceSourceType } from '@/lib/trip/backend-types'
import { legsForDay, orderedDays, buildPlaceIndex } from '@/lib/trip/selectors'

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN

const PIN_COLOR: Record<PlaceSourceType, string> = {
  reel_extracted: '#C9974E',
  user_requested: '#F2ECE0',
  agent_suggested: '#8FB4C9',
}

export default function TripMap({
  bundle, activeDayNumber, selectedPlaceId, onSelectPlace,
}: {
  bundle: TripBundle
  activeDayNumber: number
  selectedPlaceId: string | null
  onSelectPlace: (placeId: string) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const markersRef = useRef<mapboxgl.Marker[]>([])
  const routeIdsRef = useRef<string[]>([])
  const loadedRef = useRef(false)

  // Create the map once.
  useEffect(() => {
    if (!TOKEN || !containerRef.current || mapRef.current) return
    mapboxgl.accessToken = TOKEN
    const first = bundle.places[0]?.place
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/standard',
      projection: 'globe',
      center: first ? [first.lng, first.lat] : [0, 20],
      zoom: 1.4,
      pitch: 0,
    })
    mapRef.current = map
    map.on('load', () => {
      loadedRef.current = true
      // Standard style (v3): dark cosmic look via the night light preset; globe renders its own atmosphere.
      map.setConfigProperty('basemap', 'lightPreset', 'night')
      drawMarkers()
      drawRoutes()
      flyToTrip()
    })
    return () => {
      map.remove()
      mapRef.current = null
      loadedRef.current = false
      markersRef.current = []
      routeIdsRef.current = []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function drawMarkers() {
    const map = mapRef.current
    if (!map) return
    markersRef.current.forEach((m) => m.remove())
    markersRef.current = []
    for (const tp of bundle.places) {
      const el = document.createElement('button')
      el.type = 'button'
      el.setAttribute('aria-label', tp.place.name)
      el.style.cssText =
        `width:14px;height:14px;border-radius:9999px;border:2px solid #050506;cursor:pointer;` +
        `background:${PIN_COLOR[tp.source_type]};box-shadow:0 0 0 1px rgba(242,236,224,0.3)`
      el.addEventListener('click', (e) => { e.stopPropagation(); onSelectPlace(tp.place_id) })
      const marker = new mapboxgl.Marker({ element: el }).setLngLat([tp.place.lng, tp.place.lat]).addTo(map)
      markersRef.current.push(marker)
    }
  }

  function clearRoutes() {
    const map = mapRef.current
    if (!map) return
    for (const id of routeIdsRef.current) {
      if (map.getLayer(id)) map.removeLayer(id)
      if (map.getSource(id)) map.removeSource(id)
    }
    routeIdsRef.current = []
  }

  function drawRoutes() {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    clearRoutes()
    const day = orderedDays(bundle).find((d) => d.day_number === activeDayNumber)
    if (!day) return
    for (const leg of legsForDay(bundle, day.id)) {
      if (leg.status !== 'ok' || !leg.route_geometry) continue // skip no_route/failed legs
      const id = `route-${leg.id}`
      map.addSource(id, {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: leg.route_geometry },
      })
      map.addLayer({
        id,
        type: 'line',
        source: id,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#C9974E', 'line-width': 3, 'line-opacity': 0.85 },
      })
      routeIdsRef.current.push(id)
    }
  }

  function flyToTrip() {
    const map = mapRef.current
    if (!map) return
    const pts = bundle.places.map((tp) => [tp.place.lng, tp.place.lat] as [number, number])
    if (pts.length === 0) return
    const bounds = new mapboxgl.LngLatBounds()
    pts.forEach((p) => bounds.extend(p))
    map.fitBounds(bounds, { padding: 80, maxZoom: 13, pitch: 45, duration: 2200 })
  }

  // Redraw routes when the active day changes.
  useEffect(() => {
    if (loadedRef.current) drawRoutes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDayNumber])

  // Fly to the selected place.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !selectedPlaceId) return
    const idx = buildPlaceIndex(bundle)
    const place = idx.get(selectedPlaceId)
    if (place) map.flyTo({ center: [place.lng, place.lat], zoom: 14, pitch: 55, duration: 1400, essential: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPlaceId])

  if (!TOKEN) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[var(--deep)]">
        <p className="type-label text-xs uppercase tracking-wide text-[var(--muted)]">Map unavailable — token missing</p>
      </div>
    )
  }
  return <div ref={containerRef} data-testid="trip-map" className="h-full w-full" />
}
