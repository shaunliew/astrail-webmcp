'use client'

import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import type { SavedReelPlaceProof } from '@/lib/reels/backend-types'

export default function VerifiedPlacesMap({ places }: { places: SavedReelPlaceProof[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const markersRef = useRef<mapboxgl.Marker[]>([])
  const token = process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN

  useEffect(() => {
    if (!token || !containerRef.current || mapRef.current) return

    mapboxgl.accessToken = token
    const first = places[0]
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/standard',
      projection: 'globe',
      center: first ? [first.lng, first.lat] : [0, 20],
      zoom: first ? 8 : 1.4,
      pitch: 0,
    })
    mapRef.current = map

    const resizeObserver = new ResizeObserver(() => { mapRef.current?.resize() })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      markersRef.current.forEach((marker) => marker.remove())
      markersRef.current = []
      map.remove()
      mapRef.current = null
    }
    // The map is initialized once; the next effect updates proofs without recreating WebGL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    markersRef.current.forEach((marker) => marker.remove())
    markersRef.current = places.map((place) => (
      new mapboxgl.Marker()
        .setLngLat([place.lng, place.lat])
        .addTo(map)
    ))

    if (places.length > 0) {
      const bounds = new mapboxgl.LngLatBounds()
      places.forEach((place) => bounds.extend([place.lng, place.lat]))
      map.fitBounds(bounds, { padding: 64, maxZoom: 12, duration: 0 })
    }
  }, [places])

  if (!token) {
    return (
      <div role="status" className="flex min-h-64 items-center justify-center rounded-lg bg-[var(--deep)] p-4">
        <p className="type-label text-xs uppercase tracking-wide text-[var(--muted)]">Map unavailable — token missing</p>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      data-testid="verified-places-map"
      aria-label="Verified places map"
      className="min-h-64 w-full overflow-hidden rounded-lg border border-[var(--line)]"
    />
  )
}
