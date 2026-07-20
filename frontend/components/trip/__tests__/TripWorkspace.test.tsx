import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
import { placesForDay } from '@/lib/trip/selectors'

const { getTrip, MapCtor, mapInstance } = vi.hoisted(() => {
  const handler = () => ({ enable: vi.fn(), disable: vi.fn() })
  const mapInstance = {
    on: vi.fn(), setConfigProperty: vi.fn(),
    remove: vi.fn(), resize: vi.fn(), stop: vi.fn(),
    style: { setTransition: vi.fn() },
    scrollZoom: handler(), boxZoom: handler(), dragRotate: handler(), dragPan: handler(),
    keyboard: handler(), doubleClickZoom: handler(), touchZoomRotate: handler(), touchPitch: handler(),
  }
  return { getTrip: vi.fn(), MapCtor: vi.fn(() => mapInstance), mapInstance }
})

vi.mock('@/lib/trip/supabase-api', () => ({ getTrip }))
vi.mock('@/components/map/TripMap', () => ({ default: () => <div data-testid="trip-map" /> }))
vi.mock('mapbox-gl', () => ({
  default: { Map: MapCtor, Marker: vi.fn(), LngLatBounds: vi.fn(), accessToken: '' },
}))
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}))

import MapProvider from '@/components/map/MapProvider'
import TripWorkspace from '@/components/trip/TripWorkspace'

function fireLoad() {
  const load = mapInstance.on.mock.calls.find((c) => c[0] === 'load')
  act(() => { (load?.[1] as () => void)?.() })
}

// The shell map is built lazily, so acquisition settles a microtask after mount.
async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

function renderWorkspace(tripId: string) {
  return render(
    <MapProvider>
      <TripWorkspace tripId={tripId} />
    </MapProvider>,
  )
}

describe('TripWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN = 'pk.test'
  })
  afterEach(() => { delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN })

  it('loads the trip and renders day-1 places', async () => {
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    renderWorkspace(TOKYO_TRIP.trip.id)
    const firstDay1Place = placesForDay(TOKYO_TRIP, 1)[0].place.name
    expect(await screen.findByText(firstDay1Place)).toBeInTheDocument()
    expect(await screen.findByTestId('trip-map')).toBeInTheDocument()
  })

  it('switching days swaps the visible places', async () => {
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    renderWorkspace(TOKYO_TRIP.trip.id)
    const day1Place = placesForDay(TOKYO_TRIP, 1)[0].place.name
    const day3Place = placesForDay(TOKYO_TRIP, 3)[0].place.name
    // wait for load
    await screen.findByRole('tab', { name: /day 3/i })
    fireEvent.click(screen.getByRole('tab', { name: /day 3/i }))
    // getAllByText: day 3's narrated title is also the place name (Tokyo Disneyland)
    await waitFor(() => expect(screen.getAllByText(day3Place).length).toBeGreaterThan(0))
    expect(screen.queryByText(day1Place)).not.toBeInTheDocument()
  })

  it('shows a not-found state for an unknown trip id', async () => {
    getTrip.mockResolvedValueOnce(null)
    renderWorkspace('does_not_exist')
    expect(await screen.findByText(/not found/i)).toBeInTheDocument()
  })

  it('shows the failed state for failed trips', async () => {
    getTrip.mockResolvedValueOnce({ ...TOKYO_TRIP, trip: { ...TOKYO_TRIP.trip, status: 'failed' } })
    renderWorkspace(TOKYO_TRIP.trip.id)
    expect(await screen.findByText(/generation failed/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /plan a new trip/i })).toHaveAttribute('href', '/app')
  })

  it('shows the generating state for in-progress trips', async () => {
    getTrip.mockResolvedValueOnce({ ...TOKYO_TRIP, trip: { ...TOKYO_TRIP.trip, status: 'generating' } })
    renderWorkspace(TOKYO_TRIP.trip.id)
    expect(await screen.findByText(/still generating/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument()
  })

  // Arriving from generation, the relight is mid-flight while this fetch runs. If the
  // loading state took the screen the signature moment would play behind a spinner.
  it('holds the shell map on screen while the trip loads', async () => {
    let settle!: (b: unknown) => void
    getTrip.mockImplementationOnce(() => new Promise((r) => { settle = r }))
    renderWorkspace(TOKYO_TRIP.trip.id)
    await flush()

    expect(screen.getByText(/loading trip/i)).toBeInTheDocument()
    expect(MapCtor).toHaveBeenCalledTimes(1)

    await act(async () => { settle(TOKYO_TRIP) })
    expect(await screen.findByTestId('trip-map')).toBeInTheDocument()
  })

  it('holds the shell map on screen while the trip is still generating', async () => {
    getTrip.mockResolvedValueOnce({ ...TOKYO_TRIP, trip: { ...TOKYO_TRIP.trip, status: 'generating' } })
    renderWorkspace(TOKYO_TRIP.trip.id)
    await screen.findByText(/still generating/i)
    await flush()

    expect(MapCtor).toHaveBeenCalledTimes(1)
  })

  // Nothing to map once the trip turns out to be missing, so the map is dropped again
  // rather than left glowing behind a dead end.
  it('drops the map when the trip turns out to be missing', async () => {
    let settle!: (b: unknown) => void
    getTrip.mockImplementationOnce(() => new Promise((r) => { settle = r }))
    renderWorkspace('does_not_exist')
    await flush()
    fireLoad()
    expect(screen.getByTestId('shared-map')).toHaveClass('shared-map--visible')

    await act(async () => { settle(null) })
    await flush()
    expect(screen.getByTestId('shared-map')).not.toHaveClass('shared-map--visible')
  })
})
