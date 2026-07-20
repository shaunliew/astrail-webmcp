// The signature moment: generation completes and the map relights night -> dawn on a
// live instance that survives the handoff to the trip view.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

const {
  push, getAccessToken, generateTrip, streamGeneration, getTrip, mapInstance, MapCtor,
} = vi.hoisted(() => {
  const handler = () => ({ enable: vi.fn(), disable: vi.fn() })
  const mapInstance = {
    on: vi.fn(),
    setConfigProperty: vi.fn(), fitBounds: vi.fn(), flyTo: vi.fn(),
    addSource: vi.fn(), addLayer: vi.fn(),
    getSource: vi.fn(() => undefined), getLayer: vi.fn(() => undefined),
    removeLayer: vi.fn(), removeSource: vi.fn(),
    remove: vi.fn(), resize: vi.fn(), stop: vi.fn(),
    style: { setTransition: vi.fn() },
    scrollZoom: handler(), boxZoom: handler(), dragRotate: handler(), dragPan: handler(),
    keyboard: handler(), doubleClickZoom: handler(), touchZoomRotate: handler(), touchPitch: handler(),
  }
  return {
    push: vi.fn(),
    getAccessToken: vi.fn(async () => 'token'),
    generateTrip: vi.fn(async () => ({ trip_id: 'trip_tokyo_demo' })),
    streamGeneration: vi.fn(),
    getTrip: vi.fn(),
    mapInstance,
    MapCtor: vi.fn(() => mapInstance),
  }
})

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/lib/supabase/session', () => ({ getAccessToken }))
vi.mock('@/lib/trip/api', () => ({ generateTrip, streamGeneration }))
vi.mock('@/lib/trip/supabase-api', () => ({ getTrip }))
vi.mock('mapbox-gl', () => ({
  default: {
    Map: MapCtor,
    Marker: vi.fn(() => {
      const m = { setLngLat: vi.fn(() => m), addTo: vi.fn(() => m), remove: vi.fn() }
      return m
    }),
    LngLatBounds: vi.fn(() => ({ extend: vi.fn() })),
    accessToken: '',
  },
}))
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}))

import MapProvider from '@/components/map/MapProvider'
import CreateTripFlow from '@/components/create/CreateTripFlow'
import TripWorkspace from '@/components/trip/TripWorkspace'
import { RELIGHT_MS } from '@/components/map/relight'

function fireLoad() {
  const load = mapInstance.on.mock.calls.find((c) => c[0] === 'load')
  act(() => { (load?.[1] as () => void)?.() })
}

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })))
}

/** Drives the create flow to the point where the SSE stream emits `result`. */
async function generateUntilResult() {
  const view = render(<MapProvider><CreateTripFlow /></MapProvider>)
  fireEvent.change(screen.getByLabelText(/paste.*reel/i), {
    target: { value: 'https://www.instagram.com/reel/AAA/' },
  })
  fireEvent.click(screen.getByRole('button', { name: /add links/i }))
  fireEvent.change(screen.getByLabelText(/start date/i), { target: { value: '2026-08-01' } })
  fireEvent.change(screen.getByLabelText(/end date/i), { target: { value: '2026-08-04' } })
  fireEvent.click(screen.getByRole('button', { name: /review trip brief/i }))
  fireEvent.click(await screen.findByRole('button', { name: /generate my trip/i }))
  await waitFor(() => expect(generateTrip).toHaveBeenCalled())
  await flush()
  // The night map is up and live before the result arrives.
  fireLoad()
  expect(mapInstance.setConfigProperty).toHaveBeenCalledWith('basemap', 'lightPreset', 'night')
  act(() => { emitResult() })
  await flush()
  return view
}

let emitResult: () => void = () => {}

describe('night -> dawn relight', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubReducedMotion(false)
    getTrip.mockResolvedValue(TOKYO_TRIP)
    process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN = 'pk.test'
    streamGeneration.mockImplementation(
      (_id: string, _token: string, onEvent: (e: unknown) => void) => {
        onEvent({ type: 'stage', stage: 'scrape', msg: 'Scraping 3 Reels...' })
        emitResult = () => onEvent({
          type: 'result',
          content: JSON.stringify({ trip_id: 'trip_tokyo_demo' }),
        })
        return { cancel: () => {} }
      },
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN
  })

  it('relights to dawn over the 2s beat when the result event arrives', async () => {
    await generateUntilResult()

    expect(mapInstance.style.setTransition).toHaveBeenCalledWith({ duration: RELIGHT_MS, delay: 0 })
    expect(mapInstance.setConfigProperty).toHaveBeenCalledWith('basemap', 'lightPreset', 'dawn')
  })

  it('does not relight before the result event', async () => {
    render(<MapProvider><CreateTripFlow /></MapProvider>)
    fireEvent.change(screen.getByLabelText(/paste.*reel/i), {
      target: { value: 'https://www.instagram.com/reel/AAA/' },
    })
    fireEvent.click(screen.getByRole('button', { name: /add links/i }))
    fireEvent.change(screen.getByLabelText(/start date/i), { target: { value: '2026-08-01' } })
    fireEvent.change(screen.getByLabelText(/end date/i), { target: { value: '2026-08-04' } })
    fireEvent.click(screen.getByRole('button', { name: /review trip brief/i }))
    fireEvent.click(await screen.findByRole('button', { name: /generate my trip/i }))
    await waitFor(() => expect(generateTrip).toHaveBeenCalled())
    await flush()
    fireLoad()

    expect(mapInstance.setConfigProperty).not.toHaveBeenCalledWith('basemap', 'lightPreset', 'dawn')
  })

  // The whole point of the arc: the map that was showing night is the same object that
  // relights, and it is still that object after the route change.
  it('relights the live instance and carries it across the handoff', async () => {
    const view = await generateUntilResult()
    const relitDuringGeneration = MapCtor.mock.results[0]?.value

    // router.push is mocked, so stand in for the route change the flow just requested.
    // A rerender, not a second render: Next keeps the layout mounted and swaps only the
    // page, and a fresh render() would build a second provider and a second map — which
    // is exactly the bug this test exists to catch.
    expect(push).toHaveBeenCalledWith('/app/trip/trip_tokyo_demo')
    view.rerender(<MapProvider><TripWorkspace tripId="trip_tokyo_demo" /></MapProvider>)
    await flush()

    expect(MapCtor).toHaveBeenCalledTimes(1)
    expect(mapInstance.remove).not.toHaveBeenCalled()
    expect(MapCtor.mock.results[0]?.value).toBe(relitDuringGeneration)
  })

  it('gives reduced-motion users the end state, not the journey', async () => {
    stubReducedMotion(true)
    await generateUntilResult()

    expect(mapInstance.style.setTransition).toHaveBeenCalledWith({ duration: 0, delay: 0 })
    expect(mapInstance.setConfigProperty).toHaveBeenCalledWith('basemap', 'lightPreset', 'dawn')
  })
})
