import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
import MapProvider from '@/components/map/MapProvider'
import TripMap from '@/components/map/TripMap'

const { mapInstance, MapCtor, MarkerCtor, BoundsCtor, markerElements } = vi.hoisted(() => {
  const handler = () => ({ enable: vi.fn(), disable: vi.fn() })
  const mapInstance = {
    on: vi.fn(),
    addSource: vi.fn(), addLayer: vi.fn(),
    getSource: vi.fn(() => undefined), getLayer: vi.fn(() => undefined),
    removeLayer: vi.fn(), removeSource: vi.fn(),
    flyTo: vi.fn(), fitBounds: vi.fn(), setConfigProperty: vi.fn(),
    remove: vi.fn(), resize: vi.fn(), stop: vi.fn(),
    style: { setTransition: vi.fn() },
    scrollZoom: handler(), boxZoom: handler(), dragRotate: handler(), dragPan: handler(),
    keyboard: handler(), doubleClickZoom: handler(), touchZoomRotate: handler(), touchPitch: handler(),
  }
  const MapCtor = vi.fn(() => mapInstance)
  const markerElements: HTMLElement[] = []
  const MarkerCtor = vi.fn((options: { element: HTMLElement }) => {
    markerElements.push(options.element)
    const marker = {
      setLngLat: vi.fn(() => marker), addTo: vi.fn(() => marker), remove: vi.fn(),
    }
    return marker
  })
  const BoundsCtor = vi.fn(() => ({ extend: vi.fn() }))
  return { mapInstance, MapCtor, MarkerCtor, BoundsCtor, markerElements }
})

vi.mock('mapbox-gl', () => ({
  default: { Map: MapCtor, Marker: MarkerCtor, LngLatBounds: BoundsCtor, accessToken: '' },
}))
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}))

function fireLoad() {
  const load = mapInstance.on.mock.calls.find((c) => c[0] === 'load')
  act(() => { (load?.[1] as () => void)?.() })
}

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

function renderMap(props: Partial<Parameters<typeof TripMap>[0]> = {}) {
  return render(
    <MapProvider>
      <TripMap
        bundle={TOKYO_TRIP}
        activeDayNumber={1}
        selectedPlaceId={null}
        onSelectPlace={() => {}}
        {...props}
      />
    </MapProvider>,
  )
}

describe('TripMap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    markerElements.length = 0
    process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN = 'pk.test'
    // Framing is scheduled via requestAnimationFrame (so a Strict Mode remount /
    // generation handoff can't cancel the fit — see TripMap). Run it synchronously
    // here so these effect assertions observe the framing without a frame wait.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN
    vi.unstubAllGlobals()
  })

  // It drives the shell's instance rather than building one, so the map arriving from
  // generation is the same object — that is what lets it relight instead of restart.
  it('drives the shared map at the dawn preset instead of constructing its own', async () => {
    renderMap()
    await flush()
    fireLoad()

    expect(MapCtor).toHaveBeenCalledTimes(1)
    expect(mapInstance.setConfigProperty).toHaveBeenCalledWith('basemap', 'lightPreset', 'dawn')
  })

  it('anchors wheel zoom to the map center so pins do not follow the cursor', async () => {
    renderMap()
    await flush()

    expect(mapInstance.scrollZoom.enable).toHaveBeenCalledWith({ around: 'center' })
  })

  // With one persistent instance the camera no longer resets on navigation, so the trip
  // view has to frame its own places rather than inherit the generation globe.
  it('frames its own places instead of inheriting the generation camera', async () => {
    renderMap()
    await flush()
    fireLoad()

    expect(mapInstance.fitBounds).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxZoom: 14, pitch: 45 }),
    )
  })

  it('shows a fallback and does not construct a map without a token', async () => {
    delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN
    renderMap()
    await flush()

    expect(screen.getByText(/map unavailable/i)).toBeInTheDocument()
    expect(MapCtor).not.toHaveBeenCalled()
  })

  // Navigating away, not tearing down the shell: the provider stays mounted and the map
  // survives, so layers this trip added would otherwise paint over the next one. (React
  // destroys a parent before its children, so unmounting the whole tree would null the
  // map first and this would pass without proving anything.)
  it('drops its route layers when it unmounts but the shared map lives on', async () => {
    mapInstance.getLayer.mockReturnValue({} as never)
    mapInstance.getSource.mockReturnValue({} as never)
    const view = renderMap()
    await flush()
    fireLoad()
    expect(mapInstance.addLayer).toHaveBeenCalled()

    view.rerender(<MapProvider><div /></MapProvider>)
    expect(mapInstance.removeLayer).toHaveBeenCalledWith('route-leg_1-core')
    expect(mapInstance.removeSource).toHaveBeenCalledWith('route-leg_1')
    mapInstance.getLayer.mockReturnValue(undefined as never)
    mapInstance.getSource.mockReturnValue(undefined as never)
  })

  it('draws a two-layer trail, an honest failed stub, and constellation markers', async () => {
    const view = renderMap()
    await flush()
    fireLoad()

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
    view.rerender(
      <MapProvider>
        <TripMap bundle={TOKYO_TRIP} activeDayNumber={3} selectedPlaceId={null} onSelectPlace={() => {}} />
      </MapProvider>,
    )
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
