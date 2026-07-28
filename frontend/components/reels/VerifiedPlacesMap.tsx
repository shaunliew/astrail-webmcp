'use client'

import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import type { SavedReelPlaceProof } from '@/lib/reels/backend-types'

export default function VerifiedPlacesMap({
  places,
  className,
}: {
  places: SavedReelPlaceProof[]
  className?: string
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const markersRef = useRef<mapboxgl.Marker[]>([])
  const token = process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN
  // Guard the whole screen from a map that can't start (no WebGL / low-end device):
  // Mapbox's Map constructor throws, and unhandled it trips the error boundary.
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!token || !containerRef.current || mapRef.current) return

    mapboxgl.accessToken = token
    const first = places[0]
    let map: mapboxgl.Map
    try {
      map = new mapboxgl.Map({
        container: containerRef.current,
        style: 'mapbox://styles/mapbox/standard',
        projection: 'globe',
        center: first ? [first.lng, first.lat] : [0, 20],
        zoom: first ? 8 : 1.4,
        pitch: 0,
        scrollZoom: { around: 'center' },
      })
    } catch {
      setFailed(true)
      return
    }
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

  if (!token || failed) {
    return (
      <div role="status" className={`flex items-center justify-center bg-[color:var(--night-900)] p-4 ${className ?? 'min-h-64 rounded-lg'}`}>
        <p className="font-mono text-xs uppercase tracking-wide text-[color:var(--starlight-50)]">
          {token ? 'Map unavailable on this device' : 'Map unavailable — token missing'}
        </p>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      data-testid="verified-places-map"
      aria-label="Verified places map"
      className={className ?? 'min-h-64 w-full overflow-hidden rounded-lg border border-[var(--line)]'}
    />
  )
}
