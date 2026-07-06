import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

const { mapInstance, MapCtor, MarkerCtor, BoundsCtor } = vi.hoisted(() => {
  const mapInstance = {
    on: vi.fn((evt: string, cb: () => void) => { if (evt === 'load') cb() }),
    addSource: vi.fn(), addLayer: vi.fn(),
    getSource: vi.fn(() => undefined), getLayer: vi.fn(() => undefined),
    removeLayer: vi.fn(), removeSource: vi.fn(),
    flyTo: vi.fn(), fitBounds: vi.fn(), setConfigProperty: vi.fn(), remove: vi.fn(),
  }
  const MapCtor = vi.fn(() => mapInstance)
  const MarkerCtor = vi.fn(() => ({
    setLngLat: vi.fn().mockReturnThis(), addTo: vi.fn().mockReturnThis(), remove: vi.fn(),
  }))
  const BoundsCtor = vi.fn(() => ({ extend: vi.fn() }))
  return { mapInstance, MapCtor, MarkerCtor, BoundsCtor }
})

vi.mock('mapbox-gl', () => ({
  default: { Map: MapCtor, Marker: MarkerCtor, LngLatBounds: BoundsCtor, accessToken: '' },
}))
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}))

describe('TripMap', () => {
  beforeEach(() => { MapCtor.mockClear() })
  afterEach(() => { delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN })

  it('constructs a Mapbox map when a token is present', async () => {
    process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN = 'pk.test'
    vi.resetModules()
    const { default: TripMap } = await import('@/components/map/TripMap')
    render(<TripMap bundle={TOKYO_TRIP} activeDayNumber={1} selectedPlaceId={null} onSelectPlace={() => {}} />)
    expect(MapCtor).toHaveBeenCalledTimes(1)
  })

  it('shows a fallback and does not construct a map without a token', async () => {
    vi.resetModules()
    const { default: TripMap } = await import('@/components/map/TripMap')
    render(<TripMap bundle={TOKYO_TRIP} activeDayNumber={1} selectedPlaceId={null} onSelectPlace={() => {}} />)
    expect(screen.getByText(/map unavailable/i)).toBeInTheDocument()
    expect(MapCtor).not.toHaveBeenCalled()
  })
})
