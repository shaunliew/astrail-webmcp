import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

const { mapInstance, MapCtor, MarkerCtor, BoundsCtor, markerElements } = vi.hoisted(() => {
  const mapInstance = {
    on: vi.fn((evt: string, cb: () => void) => { if (evt === 'load') cb() }),
    addSource: vi.fn(), addLayer: vi.fn(),
    getSource: vi.fn(() => undefined), getLayer: vi.fn(() => undefined),
    removeLayer: vi.fn(), removeSource: vi.fn(),
    flyTo: vi.fn(), fitBounds: vi.fn(), setConfigProperty: vi.fn(), remove: vi.fn(),
  }
  const MapCtor = vi.fn(() => mapInstance)
  const markerElements: HTMLElement[] = []
  const MarkerCtor = vi.fn((options: { element: HTMLElement }) => {
    markerElements.push(options.element)
    return {
      setLngLat: vi.fn().mockReturnThis(), addTo: vi.fn().mockReturnThis(), remove: vi.fn(),
    }
  })
  const BoundsCtor = vi.fn(() => ({ extend: vi.fn() }))
  return { mapInstance, MapCtor, MarkerCtor, BoundsCtor, markerElements }
})

vi.mock('mapbox-gl', () => ({
  default: { Map: MapCtor, Marker: MarkerCtor, LngLatBounds: BoundsCtor, accessToken: '' },
}))
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}))

describe('TripMap', () => {
  beforeEach(() => {
    MapCtor.mockClear()
    MarkerCtor.mockClear()
    markerElements.length = 0
    mapInstance.addSource.mockClear()
    mapInstance.addLayer.mockClear()
  })
  afterEach(() => { delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN })

  it('constructs a Mapbox map when a token is present', async () => {
    process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN = 'pk.test'
    vi.resetModules()
    const { default: TripMap } = await import('@/components/map/TripMap')
    render(<TripMap bundle={TOKYO_TRIP} activeDayNumber={1} selectedPlaceId={null} onSelectPlace={() => {}} />)
    expect(MapCtor).toHaveBeenCalledTimes(1)
  })

  it('anchors wheel zoom to the map center so pins do not follow the cursor', async () => {
    process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN = 'pk.test'
    vi.resetModules()
    const { default: TripMap } = await import('@/components/map/TripMap')
    render(<TripMap bundle={TOKYO_TRIP} activeDayNumber={1} selectedPlaceId={null} onSelectPlace={() => {}} />)

    expect(MapCtor).toHaveBeenCalledWith(expect.objectContaining({
      scrollZoom: { around: 'center' },
    }))
  })

  it('shows a fallback and does not construct a map without a token', async () => {
    vi.resetModules()
    const { default: TripMap } = await import('@/components/map/TripMap')
    render(<TripMap bundle={TOKYO_TRIP} activeDayNumber={1} selectedPlaceId={null} onSelectPlace={() => {}} />)
    expect(screen.getByText(/map unavailable/i)).toBeInTheDocument()
    expect(MapCtor).not.toHaveBeenCalled()
  })

  it('draws a two-layer trail, an honest failed stub, and constellation markers', async () => {
    process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN = 'pk.test'
    vi.resetModules()
    const { default: TripMap } = await import('@/components/map/TripMap')
    const view = render(<TripMap bundle={TOKYO_TRIP} activeDayNumber={1} selectedPlaceId={null} onSelectPlace={() => {}} />)

    expect(screen.getByTestId('trip-map')).toHaveClass('trip-map-container--loaded')
    expect(mapInstance.addLayer).toHaveBeenCalledWith(expect.objectContaining({
      id: 'route-leg_1-casing',
      paint: expect.objectContaining({ 'line-width': 9, 'line-opacity': 0.18 }),
    }))
    expect(mapInstance.addLayer).toHaveBeenCalledWith(expect.objectContaining({
      id: 'route-leg_1-core',
      paint: expect.objectContaining({ 'line-width': 2.6, 'line-dasharray': [0.1, 1.6] }),
    }))

    const markers = markerElements.slice(-TOKYO_TRIP.places.length)
    expect(markers.find((el) => el.getAttribute('aria-label') === 'Senso-ji Temple')).toHaveClass('constellation-pin', 'constellation-pin--reel_extracted')
    expect(markers.find((el) => el.getAttribute('aria-label') === 'Senso-ji Temple')).toHaveTextContent('1')
    expect(markers.find((el) => el.getAttribute('aria-label') === 'Shibuya Sky')).toHaveClass('constellation-pin--receding')

    mapInstance.addSource.mockClear()
    mapInstance.addLayer.mockClear()
    view.rerender(<TripMap bundle={TOKYO_TRIP} activeDayNumber={3} selectedPlaceId={null} onSelectPlace={() => {}} />)
    expect(mapInstance.addLayer).toHaveBeenCalledWith(expect.objectContaining({
      id: 'route-leg_3-stub',
      paint: expect.objectContaining({
        'line-color': '#D0705F', 'line-width': 1.5, 'line-dasharray': [1.2, 2],
      }),
    }))
    expect(mapInstance.addSource).toHaveBeenCalledWith('route-leg_3-stub-source', expect.objectContaining({
      data: expect.objectContaining({
        geometry: { type: 'LineString', coordinates: [[139.7016, 35.658], [139.8804, 35.6329]] },
      }),
    }))
  })
})
