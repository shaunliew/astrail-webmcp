'use client'

import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import type { TripBundle } from '@/lib/trip/backend-types'
import { legsForDay, orderedDays, buildPlaceIndex, pinLabelForPlace, placesForDay } from '@/lib/trip/selectors'
import { consumeTripFramed } from '@/lib/trip/map-handoff'
import { useSharedMap } from '@/components/map/MapProvider'

// A place with missing/zero/out-of-range coords is unresolved (a "saved with gaps" trip
// has these). It must not get a pin, and must NOT extend the map bounds — one (0,0) drags
// the frame out to span half the globe instead of zooming to the real places.
function hasRealCoords(lng: number, lat: number): boolean {
  return (
    Number.isFinite(lng) && Number.isFinite(lat) &&
    Math.abs(lng) <= 180 && Math.abs(lat) <= 90 &&
    (lng !== 0 || lat !== 0)
  )
}

export default function TripMap({
  bundle, activeDayNumber, selectedPlaceId, onSelectPlace,
}: {
  bundle: TripBundle
  activeDayNumber: number
  selectedPlaceId: string | null
  onSelectPlace: (placeId: string) => void
}) {
  const { hasToken, ready, getMap, acquire, release, setMarkers } = useSharedMap()
  const routeIdsRef = useRef<string[]>([])
  const framedRef = useRef(false)

  function clearRoutes() {
    const map = getMap()
    if (!map) return
    for (const id of [...routeIdsRef.current].reverse()) {
      if (map.getLayer(id)) map.removeLayer(id)
      if (map.getSource(id)) map.removeSource(id)
    }
    routeIdsRef.current = []
  }

  // Daybreak world (DESIGN-DRAFT §5): generation happens at night (GenerationScene);
  // the saved trip is explored at dawn — PRD §13's "readable trip exploration lighting".
  // Arriving from generation the map is already relighting to dawn, and re-setting the
  // same preset is a no-op, so the transition is never interrupted.
  useEffect(() => {
    const first = bundle.places[0]?.place
    acquire({
      interactive: true,
      lightPreset: 'dawn',
      center: first ? [first.lng, first.lat] : [0, 20],
      zoom: 1.4,
    })
    // Layers are ours, and the map outlives this component — leaving them behind would
    // paint this trip's routes over the next one.
    return () => {
      clearRoutes()
      release()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function drawMarkers() {
    const map = getMap()
    if (!map) return
    const markers = bundle.places.filter((tp) => hasRealCoords(tp.place.lng, tp.place.lat)).map((tp) => {
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
      return new mapboxgl.Marker({ element: el }).setLngLat([tp.place.lng, tp.place.lat]).addTo(map)
    })
    setMarkers(markers)
  }

  function drawRoutes() {
    const map = getMap()
    if (!map) return
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

  // The details panel overlays the map — the left 440px on desktop, a bottom sheet on
  // mobile — so uniform padding would frame a day's pins right underneath it. Bias the
  // padding toward the panel's edge so framed pins always land in the visible strip.
  function framePadding() {
    if (typeof window === 'undefined') return { top: 80, right: 80, bottom: 80, left: 80 }
    if (window.innerWidth >= 768) return { top: 80, right: 80, bottom: 80, left: 480 }
    return { top: 80, right: 60, bottom: Math.round(window.innerHeight * 0.42) + 40, left: 60 }
  }

  // essential: framing is not decoration — reduced-motion must still land on the pins,
  // not leave the camera wherever the last gesture (or generation) parked the globe.
  function frame(pts: [number, number][], duration: number) {
    const map = getMap()
    if (!map || pts.length === 0) return
    if (pts.length === 1) {
      map.flyTo({ center: pts[0], zoom: 13.5, pitch: 45, padding: framePadding(), duration, essential: true })
      return
    }
    const bounds = new mapboxgl.LngLatBounds()
    pts.forEach((p) => bounds.extend(p))
    map.fitBounds(bounds, { padding: framePadding(), maxZoom: 14, pitch: 45, duration, essential: true })
  }

  function pointsForDay(dayNumber: number): [number, number][] {
    return placesForDay(bundle, dayNumber)
      .filter((tp) => hasRealCoords(tp.place.lng, tp.place.lat))
      .map((tp) => [tp.place.lng, tp.place.lat] as [number, number])
  }

  function flyToTrip(duration = 2200) {
    const pts = bundle.places
      .filter((tp) => hasRealCoords(tp.place.lng, tp.place.lat))
      .map((tp) => [tp.place.lng, tp.place.lat] as [number, number])
    frame(pts, duration)
  }

  // The shared map fires 'load' once ever, and this component usually mounts long after
  // that — so first draw keys off `ready`, not a load listener that will never fire.
  // Framing is explicit for the same reason: the camera no longer resets on navigation,
  // so without this the trip would inherit wherever generation left the globe.
  //
  // Deferred to the next frame, deliberately. Two teardown paths call release() ->
  // map.stop(), which cancels an in-flight fitBounds: React Strict Mode's dev
  // mount->cleanup->remount, and the generation->trip handoff (the outgoing scene's
  // release races our fit). Both run their cleanup synchronously before the next frame,
  // so scheduling the fit in an rAF lets stop() fire first and our framing win. The
  // effect's own cleanup cancels a still-pending frame, so the remount reschedules a
  // fresh one instead of being locked out by a one-shot guard.
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    const raf = requestAnimationFrame(() => {
      if (cancelled) return
      framedRef.current = true
      drawMarkers()
      drawRoutes()
      // Arriving from the trips dashboard already framed on this trip → settle into the
      // panel geometry (short) rather than re-fly the whole camera (full). Any other entry
      // (generation handoff, direct load) never marks the handoff, so it frames normally.
      const inherited = consumeTripFramed(bundle.trip.id)
      flyToTrip(inherited ? 900 : 2200)
    })
    return () => { cancelled = true; cancelAnimationFrame(raf) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  // Redraw markers/routes AND fly to the day's pins when the active day changes.
  // Without the reframe, switching days only relabels pins in place — the whole point of
  // picking a day is to see that day's stops enlarged on the map. Falls back to the whole
  // trip when a day has no resolved-coordinate places, so the camera is never stranded.
  useEffect(() => {
    if (!ready || !framedRef.current) return
    drawMarkers()
    drawRoutes()
    const pts = pointsForDay(activeDayNumber)
    frame(pts.length ? pts : bundle.places
      .filter((tp) => hasRealCoords(tp.place.lng, tp.place.lat))
      .map((tp) => [tp.place.lng, tp.place.lat] as [number, number]), 1400)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDayNumber])

  // Refresh marker selection and fly to the selected place.
  useEffect(() => {
    if (!ready) return
    drawMarkers()
    const map = getMap()
    if (!map || !selectedPlaceId) return
    const place = buildPlaceIndex(bundle).get(selectedPlaceId)
    if (place && hasRealCoords(place.lng, place.lat)) {
      map.flyTo({ center: [place.lng, place.lat], zoom: 14, pitch: 55, padding: framePadding(), duration: 1400, essential: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPlaceId])

  if (!hasToken) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[var(--deep)]">
        <p className="type-label text-xs uppercase tracking-wide text-[var(--muted)]">Map unavailable — token missing</p>
      </div>
    )
  }
  // The canvas itself is the shell's fixed layer; this component only drives it.
  return null
}
