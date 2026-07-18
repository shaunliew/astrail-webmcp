'use client'

import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import type { TripBundle } from '@/lib/trip/backend-types'
import { legsForDay, orderedDays, buildPlaceIndex, pinLabelForPlace } from '@/lib/trip/selectors'

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN

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
  const [mapLoaded, setMapLoaded] = useState(false)

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
      scrollZoom: { around: 'center' },
    })
    mapRef.current = map
    map.on('load', () => {
      loadedRef.current = true
      setMapLoaded(true)
      // Daybreak world (DESIGN-DRAFT §5): generation happens at night (GenerationScene);
      // the saved trip is explored at dawn — PRD §13's "readable trip exploration lighting".
      map.setConfigProperty('basemap', 'lightPreset', 'dawn')
      drawMarkers()
      drawRoutes()
      flyToTrip()
    })

    // Mapbox's built-in trackResize only reliably corrects the canvas on a window
    // resize event. When the container changes size for any other reason — device
    // rotation, mobile browser chrome collapsing, a parent layout change — the WebGL
    // canvas can stay frozen at its old size, and the surplus container renders black.
    // Observing the container directly and calling resize() closes that gap.
    const resizeObserver = new ResizeObserver(() => { mapRef.current?.resize() })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
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
      const label = pinLabelForPlace(bundle, tp, activeDayNumber)
      el.className = [
        'constellation-pin',
        `constellation-pin--${tp.source_type}`,
        label ? '' : 'constellation-pin--receding',
        tp.place_id === selectedPlaceId ? 'constellation-pin--selected' : '',
      ].filter(Boolean).join(' ')
      el.textContent = label ?? ''
      el.addEventListener('click', (e) => { e.stopPropagation(); onSelectPlace(tp.place_id) })
      const marker = new mapboxgl.Marker({ element: el }).setLngLat([tp.place.lng, tp.place.lat]).addTo(map)
      markersRef.current.push(marker)
    }
  }

  function clearRoutes() {
    const map = mapRef.current
    if (!map) return
    for (const id of [...routeIdsRef.current].reverse()) {
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
    const placeIndex = buildPlaceIndex(bundle)
    for (const leg of legsForDay(bundle, day.id)) {
      const id = `route-${leg.id}`
      if (leg.status === 'ok' && leg.route_geometry) {
        const casingId = `${id}-casing`
        const coreId = `${id}-core`
        map.addSource(id, {
          type: 'geojson',
          data: { type: 'Feature', properties: {}, geometry: leg.route_geometry },
        })
        map.addLayer({
          id: casingId,
          type: 'line',
          source: id,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': '#C9974E', 'line-width': 9, 'line-opacity': 0.18 },
        })
        map.addLayer({
          id: coreId,
          type: 'line',
          source: id,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': '#C9974E',
            'line-width': 2.6,
            'line-opacity': 0.95,
            'line-dasharray': [0.1, 1.6],
          },
        })
        routeIdsRef.current.push(id, casingId, coreId)
        continue
      }

      const from = leg.from_place_id ? placeIndex.get(leg.from_place_id) : undefined
      const to = leg.to_place_id ? placeIndex.get(leg.to_place_id) : undefined
      if (!from || !to) continue
      const stubSourceId = `${id}-stub-source`
      const stubLayerId = `${id}-stub`
      const stubGeometry = {
        type: 'LineString' as const,
        coordinates: [[from.lng, from.lat], [to.lng, to.lat]] as [number, number][],
      }
      map.addSource(stubSourceId, {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: stubGeometry },
      })
      map.addLayer({
        id: stubLayerId,
        type: 'line',
        source: stubSourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#D0705F',
          'line-width': 1.5,
          'line-opacity': 0.5,
          'line-dasharray': [1.2, 2],
        },
      })
      routeIdsRef.current.push(stubSourceId, stubLayerId)
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

  // Redraw markers and routes when the active day changes.
  useEffect(() => {
    if (loadedRef.current) {
      drawMarkers()
      drawRoutes()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDayNumber])

  // Refresh marker selection and fly to the selected place.
  useEffect(() => {
    const map = mapRef.current
    if (loadedRef.current) drawMarkers()
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
  return (
    <div
      ref={containerRef}
      data-testid="trip-map"
      className={['trip-map-container h-full w-full', mapLoaded ? 'trip-map-container--loaded' : ''].filter(Boolean).join(' ')}
    />
  )
}
