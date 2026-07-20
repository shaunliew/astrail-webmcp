import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
import type { StreamEvent } from '@/lib/trip/backend-types'
import MapProvider from '@/components/map/MapProvider'
import GenerationScene from '@/components/create/GenerationScene'

const { mapInstance, MapCtor, MarkerCtor, markerElements, getTrip } = vi.hoisted(() => {
  const handler = () => ({ enable: vi.fn(), disable: vi.fn() })
  const mapInstance = {
    on: vi.fn(),
    setConfigProperty: vi.fn(), fitBounds: vi.fn(),
    remove: vi.fn(), resize: vi.fn(), stop: vi.fn(),
    style: { setTransition: vi.fn() },
    scrollZoom: handler(), boxZoom: handler(), dragRotate: handler(), dragPan: handler(),
    keyboard: handler(), doubleClickZoom: handler(), touchZoomRotate: handler(), touchPitch: handler(),
  }
  const markerElements: HTMLElement[] = []
  const addedTo: unknown[] = []
  const MarkerCtor = vi.fn((options: { element: HTMLElement }) => {
    markerElements.push(options.element)
    const marker = {
      setLngLat: vi.fn(() => marker),
      addTo: vi.fn((m: unknown) => { addedTo.push(m); return marker }),
      remove: vi.fn(),
      addedTo,
    }
    return marker
  })
  return {
    mapInstance,
    MapCtor: vi.fn(() => mapInstance),
    MarkerCtor,
    markerElements,
    getTrip: vi.fn(),
  }
})

vi.mock('mapbox-gl', () => ({
  default: {
    Map: MapCtor,
    Marker: MarkerCtor,
    LngLatBounds: vi.fn(() => ({ extend: vi.fn() })),
    accessToken: '',
  },
}))
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}))
vi.mock('@/lib/trip/supabase-api', () => ({ getTrip }))

function fireLoad() {
  const load = mapInstance.on.mock.calls.find((c) => c[0] === 'load')
  act(() => { (load?.[1] as () => void)?.() })
}

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

const PLACES_READY: StreamEvent[] = [{ type: 'stage', stage: 'dedup', msg: 'deduping' }]

function renderScene(events: StreamEvent[] = [], tripId: string | null = 'trip_tokyo_demo') {
  return render(
    <MapProvider>
      <GenerationScene tripId={tripId} events={events} />
    </MapProvider>,
  )
}

describe('GenerationScene', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    markerElements.length = 0
    getTrip.mockResolvedValue(TOKYO_TRIP)
    process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN = 'pk.test'
  })
  afterEach(() => { delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN })

  // It must not build its own map: an instance it owned would die with this component,
  // which is exactly what made the night->dawn relight impossible.
  it('drives the shell map at the night preset instead of constructing its own', async () => {
    renderScene()
    await flush()
    fireLoad()

    expect(MapCtor).toHaveBeenCalledTimes(1)
    expect(mapInstance.setConfigProperty).toHaveBeenCalledWith('basemap', 'lightPreset', 'night')
  })

  it('leaves the map inert — this scene is a backdrop, not something to fly around', async () => {
    renderScene()
    await flush()

    expect(mapInstance.dragPan.disable).toHaveBeenCalled()
    expect(mapInstance.scrollZoom.disable).toHaveBeenCalled()
    expect(mapInstance.dragPan.enable).not.toHaveBeenCalled()
    expect(mapInstance.scrollZoom.enable).not.toHaveBeenCalled()
  })

  it('lands pins on the shared instance once a places-bearing stage fires', async () => {
    renderScene(PLACES_READY)
    await flush()
    fireLoad()
    await flush()

    expect(getTrip).toHaveBeenCalledWith('trip_tokyo_demo')
    expect(markerElements).toHaveLength(TOKYO_TRIP.places.length)
    expect(markerElements[0]).toHaveClass('pin-land')
    const marker = MarkerCtor.mock.results[0]?.value as { addedTo: unknown[] }
    expect(marker.addedTo[0]).toBe(mapInstance)
    expect(mapInstance.fitBounds).toHaveBeenCalled()
  })

  it('does not fetch places before a places-bearing stage', async () => {
    renderScene([{ type: 'stage', stage: 'scrape', msg: 'scraping' }])
    await flush()
    fireLoad()
    await flush()

    expect(getTrip).not.toHaveBeenCalled()
  })

  it('narrates over the starfield when no token is configured', async () => {
    delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN
    const { container } = renderScene(PLACES_READY)
    await flush()

    expect(MapCtor).not.toHaveBeenCalled()
    expect(container.querySelector('.hero-field')).not.toBeNull()
    expect(screen.getByText(/deduping/i)).toBeInTheDocument()
  })
})
