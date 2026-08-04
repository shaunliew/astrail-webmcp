import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
import { markTripFramed } from '@/lib/trip/map-handoff'
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

// The trail upgrades each same-day hop to the leg's road geometry (selectors.trailCoordinates),
// so the expectations below derive the interior points from the fixture rather than hardcoding
// floats. Expected is assembled by a DIFFERENT expression than the implementation (explicit
// literals + slices vs. a loop over the legs), so it is not circular.
const geomOf = (id: string) =>
  TOKYO_TRIP.transport_legs.find((l) => l.id === id)!.route_geometry!.coordinates

function trailCoords(): number[][] {
  const call = mapInstance.addSource.mock.calls.find((c) => c[0] === 'trip-trail')
  return (call![1] as { data: { geometry: { coordinates: number[][] } } }).data.geometry.coordinates
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

  // Seamless dashboard -> workspace handoff: the trips dashboard already framed this trip on
  // the shared map, so the workspace settles quickly into its panel geometry rather than
  // re-flying the whole camera.
  it('settles quickly when the dashboard already framed this trip', async () => {
    markTripFramed(TOKYO_TRIP.trip.id)
    renderMap()
    await flush()
    fireLoad()

    expect(mapInstance.fitBounds).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ duration: 900 }),
    )
  })

  it('does a full framing fly on a direct load (no dashboard handoff)', async () => {
    renderMap()
    await flush()
    fireLoad()

    expect(mapInstance.fitBounds).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ duration: 2200 }),
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
    expect(mapInstance.removeLayer).toHaveBeenCalledWith('trip-trail-core')
    expect(mapInstance.removeSource).toHaveBeenCalledWith('trip-trail')
    mapInstance.getLayer.mockReturnValue(undefined as never)
    mapInstance.getSource.mockReturnValue(undefined as never)
  })

  it('draws one continuous trail through every stop and numbers them globally', async () => {
    renderMap()
    await flush()
    fireLoad()

    // one brass journey line (casing + dashed core), not per-leg segments
    expect(mapInstance.addLayer).toHaveBeenCalledWith(expect.objectContaining({
      id: 'trip-trail-casing',
      paint: expect.objectContaining({ 'line-width': 9, 'line-opacity': 0.18 }),
    }))
    expect(mapInstance.addLayer).toHaveBeenCalledWith(expect.objectContaining({
      id: 'trip-trail-core',
      paint: expect.objectContaining({ 'line-width': 2.6, 'line-dasharray': [0.1, 1.6] }),
    }))
    // the line threads every dayed stop in (day, sort_order) order, Day 1 → last day, with
    // each same-day hop's road interior spliced in between its two pins
    expect(mapInstance.addSource).toHaveBeenCalledWith('trip-trail', expect.objectContaining({
      data: expect.objectContaining({
        geometry: {
          type: 'LineString',
          coordinates: [
            [139.7967, 35.7148],             // Senso-ji    (Day 1, stop 1)
            ...geomOf('leg_1').slice(1, -1), // road interior, Day 1 hop
            [139.7906, 35.6497],             // teamLab     (Day 1, stop 2)
            [139.7016, 35.658],              // Shibuya Sky (Day 2, stop 3) — cross-day, straight
            ...geomOf('leg_2').slice(1, -1), // road interior, Day 2 hop
            [139.7002, 35.6606],             // Ichiran     (Day 2, stop 4)
            [139.8804, 35.6329],             // Disneyland  (Day 3, stop 5) — cross-day, straight
          ],
        },
      }),
    }))

    const markers = markerElements.slice(-TOKYO_TRIP.places.length)
    const byLabel = (name: string) => markers.find((el) => el.getAttribute('aria-label') === name)!
    expect(byLabel('Senso-ji Temple')).toHaveClass('constellation-pin', 'constellation-pin--reel_extracted')
    expect(byLabel('Senso-ji Temple')).toHaveTextContent('1')
    // a later-day stop is no longer dimmed — it carries its global number and stays lit
    expect(byLabel('Shibuya Sky')).not.toHaveClass('constellation-pin--receding')
    expect(byLabel('Shibuya Sky')).toHaveTextContent('3')
    expect(byLabel('Tokyo Disneyland')).toHaveTextContent('5')
    // the undayed base hotel is not a stop on the trail — it recedes, unnumbered
    expect(byLabel('Shinjuku Granbell Hotel')).toHaveClass('constellation-pin--receding')
  })

  it('keeps one whole-trip trail — switching the active day does not redraw it', async () => {
    const view = renderMap()
    await flush()
    fireLoad()

    mapInstance.addSource.mockClear()
    mapInstance.flyTo.mockClear()
    view.rerender(
      <MapProvider>
        <TripMap bundle={TOKYO_TRIP} activeDayNumber={3} selectedPlaceId={null} onSelectPlace={() => {}} />
      </MapProvider>,
    )
    // day change only moves the camera; the trail is day-independent, so it is not re-added
    expect(mapInstance.addSource).not.toHaveBeenCalledWith('trip-trail', expect.anything())
    expect(mapInstance.flyTo).toHaveBeenCalled() // Day 3's single stop → camera flies there
  })

  // The wiring itself: the source must receive the LEG's road points, not five straight
  // pin-to-pin coordinates. Reverting drawTrail to `stops.map(...)` reddens this.
  it('draws the trail from per-leg route geometry, not straight pin-to-pin links', async () => {
    renderMap()
    await flush()
    fireLoad()

    const coordinates = trailCoords()
    for (const point of [...geomOf('leg_1').slice(1, -1), ...geomOf('leg_2').slice(1, -1)]) {
      expect(coordinates).toContainEqual(point)
    }
    // 5 stops + 4 interior points on each of the two same-day hops
    expect(coordinates).toHaveLength(13)
  })

  // ---- Hotel-hub map (plan 2026-08-04-hotel-hub-map, T9) ----
  // Route mode is covered by the trail test above (the receding base-hotel pin at 'the undayed
  // base hotel is not a stop on the trail' MUST stay green — it proves route mode is untouched).
  // The spoke GEOMETRY is unit-tested in T7 (selectors); here we assert at the marker-class /
  // layer-added level, the right altitude for canvas-heavy map rendering.

  it('hub mode pins the selected placed hotel, draws spokes, and suppresses the duplicate base-hotel place pin', async () => {
    renderMap({ selectedHotelId: 'hotel_1', layerMode: 'hub' })
    await flush()
    fireLoad()

    // exactly one distinct hub pin, at the selected PLACED hotel (hotel_1 → geo_status 'placed')
    const hubPins = markerElements.filter((el) => el.classList.contains('hotel-hub-pin'))
    expect(hubPins).toHaveLength(1)
    expect(hubPins[0]).toHaveAttribute('aria-label', 'Shinjuku Granbell Hotel')

    // the base-hotel PLACE marker is suppressed — no constellation-pin duplicate under the hub
    const baseDuplicate = markerElements.filter(
      (el) => el.classList.contains('constellation-pin')
        && el.getAttribute('aria-label') === 'Shinjuku Granbell Hotel',
    )
    expect(baseDuplicate).toHaveLength(0)

    // spokes layer added; the itinerary trail is gated OFF in hub mode
    expect(mapInstance.addSource).toHaveBeenCalledWith('hotel-spokes', expect.anything())
    expect(mapInstance.addSource).not.toHaveBeenCalledWith('trip-trail', expect.anything())
  })

  // Proves the [selectedHotelId, layerMode] redraw effect is load-bearing: a live toggle must tear
  // the trail down (via routeIdsRef/clearRoutes) and draw the spokes in its place.
  it('toggling route -> hub tears down the itinerary trail and draws the hotel spokes', async () => {
    const view = renderMap() // route mode by default
    await flush()
    fireLoad()
    expect(mapInstance.addSource).toHaveBeenCalledWith('trip-trail', expect.anything())

    // clearRoutes only removes layers/sources the map reports it currently has
    mapInstance.getLayer.mockReturnValue({} as never)
    mapInstance.getSource.mockReturnValue({} as never)
    mapInstance.addSource.mockClear()
    view.rerender(
      <MapProvider>
        <TripMap
          bundle={TOKYO_TRIP}
          activeDayNumber={1}
          selectedPlaceId={null}
          onSelectPlace={() => {}}
          selectedHotelId="hotel_1"
          layerMode="hub"
        />
      </MapProvider>,
    )

    expect(mapInstance.removeLayer).toHaveBeenCalledWith('trip-trail-core')
    expect(mapInstance.addSource).toHaveBeenCalledWith('hotel-spokes', expect.anything())
    mapInstance.getLayer.mockReturnValue(undefined as never)
    mapInstance.getSource.mockReturnValue(undefined as never)
  })

  it('hub mode with no hotel selected draws no hub and no spokes (honest empty-state)', async () => {
    renderMap({ selectedHotelId: null, layerMode: 'hub' })
    await flush()
    fireLoad()

    expect(markerElements.filter((el) => el.classList.contains('hotel-hub-pin'))).toHaveLength(0)
    expect(mapInstance.addSource).not.toHaveBeenCalledWith('hotel-spokes', expect.anything())
  })

  it('hub mode with an unresolved (unplaceable) selected hotel draws no hub and no spokes', async () => {
    renderMap({ selectedHotelId: 'hotel_2', layerMode: 'hub' }) // hotel_2 → geo_status 'unresolved'
    await flush()
    fireLoad()

    expect(markerElements.filter((el) => el.classList.contains('hotel-hub-pin'))).toHaveLength(0)
    expect(mapInstance.addSource).not.toHaveBeenCalledWith('hotel-spokes', expect.anything())
  })
})
