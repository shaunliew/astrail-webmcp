import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { useEffect } from 'react'
import MapProvider, { useSharedMap, type SharedMapContextValue } from '@/components/map/MapProvider'

const { mapInstance, MapCtor, markerRemovals, makeMarker } = vi.hoisted(() => {
  const handler = () => ({ enable: vi.fn(), disable: vi.fn() })
  const mapInstance = {
    on: vi.fn(),
    setConfigProperty: vi.fn(),
    remove: vi.fn(), resize: vi.fn(), stop: vi.fn(),
    style: { setTransition: vi.fn() },
    scrollZoom: handler(), boxZoom: handler(), dragRotate: handler(), dragPan: handler(),
    keyboard: handler(), doubleClickZoom: handler(), touchZoomRotate: handler(), touchPitch: handler(),
  }
  const MapCtor = vi.fn(() => mapInstance)
  const markerRemovals: string[] = []
  const makeMarker = (id: string) => ({ remove: vi.fn(() => { markerRemovals.push(id) }) })
  return { mapInstance, MapCtor, markerRemovals, makeMarker }
})

vi.mock('mapbox-gl', () => ({
  default: { Map: MapCtor, Marker: vi.fn(), LngLatBounds: vi.fn(), accessToken: '' },
}))
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}))

// Fires the Mapbox 'load' callback the provider registered, as Mapbox would once the
// style parses. Separate from construction so tests can assert the pre-ready state.
function fireLoad() {
  const load = mapInstance.on.mock.calls.find((c) => c[0] === 'load')
  act(() => { (load?.[1] as () => void)?.() })
}

// The Mapbox bundle is imported lazily, so construction settles a microtask after mount.
async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

/** Minimal stand-in for a route-level consumer (GenerationScene / TripMap). */
function Consumer({
  interactive, lightPreset,
}: {
  interactive: boolean
  lightPreset: 'night' | 'dawn'
}) {
  const { acquire, release } = useSharedMap()
  useEffect(() => {
    acquire({ interactive, lightPreset })
    return () => release()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

let ctx: SharedMapContextValue | null = null
function Grabber() { ctx = useSharedMap(); return null }

describe('MapProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    markerRemovals.length = 0
    ctx = null
    process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN = 'pk.test'
  })
  afterEach(() => { delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN })

  it('does not construct a map until a consumer acquires it', async () => {
    render(<MapProvider><div /></MapProvider>)
    await flush()
    expect(MapCtor).not.toHaveBeenCalled()
  })

  it('constructs exactly one map when a consumer acquires', async () => {
    render(
      <MapProvider>
        <Consumer interactive={false} lightPreset="night" />
      </MapProvider>,
    )
    await flush()
    expect(MapCtor).toHaveBeenCalledTimes(1)
  })

  it('never constructs a map without a token', async () => {
    delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN
    render(
      <MapProvider>
        <Consumer interactive={false} lightPreset="night" />
      </MapProvider>,
    )
    await flush()
    expect(MapCtor).not.toHaveBeenCalled()
  })

  // The core guarantee of the whole arc: swapping consumers (the generation -> trip
  // handoff) must reuse the live instance, not tear it down and rebuild.
  it('survives a consumer swap: same instance, never removed', async () => {
    // Distinct keys force a genuine unmount + mount, which is what router.push does.
    // Without them React reconciles the same element, the effect never re-runs, and the
    // assertion would pass without ever exercising a handoff.
    const view = render(
      <MapProvider>
        <Consumer key="generation" interactive={false} lightPreset="night" />
        <Grabber />
      </MapProvider>,
    )
    await flush()
    fireLoad()
    const duringGeneration = ctx!.getMap()
    expect(duringGeneration).not.toBeNull()

    view.rerender(
      <MapProvider>
        <Consumer key="trip" interactive lightPreset="dawn" />
        <Grabber />
      </MapProvider>,
    )
    await flush()

    expect(MapCtor).toHaveBeenCalledTimes(1)
    expect(mapInstance.remove).not.toHaveBeenCalled()
    expect(ctx!.getMap()).toBe(duringGeneration)
  })

  it('replaces markers instead of accumulating them across navigations', async () => {
    render(
      <MapProvider>
        <Consumer interactive={false} lightPreset="night" />
        <Grabber />
      </MapProvider>,
    )
    await flush()
    act(() => { ctx!.setMarkers([makeMarker('a'), makeMarker('b')] as never) })
    expect(markerRemovals).toEqual([])

    act(() => { ctx!.setMarkers([makeMarker('c')] as never) })
    expect(markerRemovals).toEqual(['a', 'b'])
  })

  it('applies the light preset once ready and skips a redundant re-set', async () => {
    render(
      <MapProvider>
        <Consumer interactive={false} lightPreset="night" />
        <Grabber />
      </MapProvider>,
    )
    await flush()
    fireLoad()
    expect(mapInstance.setConfigProperty).toHaveBeenCalledWith('basemap', 'lightPreset', 'night')

    mapInstance.setConfigProperty.mockClear()
    act(() => { ctx!.setLightPreset('night') })
    expect(mapInstance.setConfigProperty).not.toHaveBeenCalled()

    act(() => { ctx!.setLightPreset('dawn', 2000) })
    expect(mapInstance.style.setTransition).toHaveBeenCalledWith({ duration: 2000, delay: 0 })
    expect(mapInstance.setConfigProperty).toHaveBeenCalledWith('basemap', 'lightPreset', 'dawn')
  })

  // The result event can beat the lazily-imported Mapbox bundle. If construction then
  // re-applied the acquiring route's preset, the map would settle on night after the
  // user had already been handed to the dawn-lit trip view.
  it('lets a relight requested mid-construction win over the acquiring preset', async () => {
    render(
      <MapProvider>
        <Consumer interactive={false} lightPreset="night" />
        <Grabber />
      </MapProvider>,
    )
    act(() => { ctx!.setLightPreset('dawn', 2000) })
    await flush()
    fireLoad()

    expect(mapInstance.setConfigProperty).toHaveBeenCalledWith('basemap', 'lightPreset', 'dawn')
    expect(mapInstance.setConfigProperty).not.toHaveBeenCalledWith('basemap', 'lightPreset', 'night')
  })

  it('disables every gesture handler for a non-interactive consumer', async () => {
    render(
      <MapProvider>
        <Consumer interactive={false} lightPreset="night" />
      </MapProvider>,
    )
    await flush()
    expect(mapInstance.dragPan.disable).toHaveBeenCalled()
    expect(mapInstance.scrollZoom.disable).toHaveBeenCalled()
    expect(mapInstance.scrollZoom.enable).not.toHaveBeenCalled()
  })

  it('anchors wheel zoom to centre for an interactive consumer', async () => {
    render(
      <MapProvider>
        <Consumer interactive lightPreset="dawn" />
      </MapProvider>,
    )
    await flush()
    expect(mapInstance.scrollZoom.enable).toHaveBeenCalledWith({ around: 'center' })
    expect(mapInstance.dragPan.enable).toHaveBeenCalled()
  })
})
