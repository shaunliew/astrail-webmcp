import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { SavedReelPlaceProof } from '@/lib/reels/backend-types'

const { MapCtor, MarkerCtor, BoundsCtor, mapInstance, markerInstances, resizeObserve, resizeDisconnect } = vi.hoisted(() => {
  const mapInstance = {
    fitBounds: vi.fn(),
    remove: vi.fn(),
    resize: vi.fn(),
  }
  const MapCtor = vi.fn(() => mapInstance)
  const markerInstances: Array<{
    setLngLat: ReturnType<typeof vi.fn>
    addTo: ReturnType<typeof vi.fn>
    remove: ReturnType<typeof vi.fn>
  }> = []
  const MarkerCtor = vi.fn(() => {
    const marker = {
      setLngLat: vi.fn().mockReturnThis(),
      addTo: vi.fn().mockReturnThis(),
      remove: vi.fn(),
    }
    markerInstances.push(marker)
    return marker
  })
  const BoundsCtor = vi.fn(() => ({ extend: vi.fn().mockReturnThis() }))
  return {
    MapCtor, MarkerCtor, BoundsCtor, mapInstance, markerInstances,
    resizeObserve: vi.fn(), resizeDisconnect: vi.fn(),
  }
})

vi.mock('mapbox-gl', () => ({
  default: { Map: MapCtor, Marker: MarkerCtor, LngLatBounds: BoundsCtor, accessToken: '' },
}))
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}))

import VerifiedPlacesMap from '@/components/reels/VerifiedPlacesMap'

const proof = (
  place_id: string,
  name: string,
  country_code: string,
  country_name: string,
  lng: number,
  lat: number,
): SavedReelPlaceProof => ({
  place_id,
  name,
  country_code,
  country_name,
  lng,
  lat,
  evidence_quote: name,
  source_url: `https://source.test/${place_id}`,
  source_reel_url: `https://www.instagram.com/reel/${place_id}/`,
  confidence: 0.95,
})

describe('VerifiedPlacesMap', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN = 'pk.test'
    globalThis.ResizeObserver = class {
      observe = resizeObserve
      unobserve = vi.fn()
      disconnect = resizeDisconnect
    }
    MapCtor.mockClear()
    MarkerCtor.mockClear()
    BoundsCtor.mockClear()
    mapInstance.fitBounds.mockClear()
    mapInstance.remove.mockClear()
    mapInstance.resize.mockClear()
    markerInstances.length = 0
    resizeObserve.mockClear()
    resizeDisconnect.mockClear()
  })

  afterEach(() => {
    cleanup()
    delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN
  })

  it('pins exact backend-verified coordinates for Japan, China, and South Korea', () => {
    const view = render(<VerifiedPlacesMap places={[
      proof('jp', 'Tokyo Tower', 'JP', 'Japan', 139.7454, 35.6586),
      proof('cn', 'The Bund', 'CN', 'China', 121.4906, 31.2410),
      proof('kr', 'Gyeongbokgung Palace', 'KR', 'South Korea', 126.9770, 37.5796),
    ]} />)

    expect(MapCtor).toHaveBeenCalledWith(expect.objectContaining({
      style: 'mapbox://styles/mapbox/standard',
      projection: 'globe',
      scrollZoom: { around: 'center' },
      center: [139.7454, 35.6586],
    }))
    expect(markerInstances.map((marker) => marker.setLngLat.mock.calls[0][0])).toEqual([
      [139.7454, 35.6586],
      [121.4906, 31.2410],
      [126.9770, 37.5796],
    ])
    expect(markerInstances.every((marker) => marker.addTo.mock.calls[0][0] === mapInstance)).toBe(true)

    view.unmount()
    markerInstances.forEach((marker) => expect(marker.remove).toHaveBeenCalledTimes(1))
    expect(resizeDisconnect).toHaveBeenCalledTimes(1)
    expect(mapInstance.remove).toHaveBeenCalledTimes(1)
  })

  it('creates zero markers when there are no verified places', () => {
    render(<VerifiedPlacesMap places={[]} />)

    expect(screen.getByTestId('verified-places-map')).toBeInTheDocument()
    expect(MarkerCtor).not.toHaveBeenCalled()
  })

  it('shows an accessible fallback without a public Mapbox token', () => {
    delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN
    render(<VerifiedPlacesMap places={[]} />)

    expect(screen.getByRole('status')).toHaveTextContent(/map unavailable.*token missing/i)
    expect(MapCtor).not.toHaveBeenCalled()
  })
})
