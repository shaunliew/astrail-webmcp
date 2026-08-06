import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
import { placesForDay } from '@/lib/trip/selectors'
import type { TripBundle } from '@/lib/trip/backend-types'

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
// Lightweight stamp: renders the tripId it receives, so the mount tests observe both presence
// (per the status matrix) and WHICH id flows (the loaded bundle's, never the route param). This
// keeps the suite's existing @/lib/trip/* mocks valid — the real panel's api/session deps stay out.
vi.mock('@/components/trip/TripFeedbackPanel', () => ({
  default: ({ tripId }: { tripId: string }) => <div data-testid="trip-feedback-panel">{tripId}</div>,
}))

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

  it('toggles the panel open/closed from the single edge control', async () => {
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    renderWorkspace(TOKYO_TRIP.trip.id)

    const toggle = await screen.findByRole('button', { name: /hide trip details/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById('trip-details-scroll')).not.toHaveAttribute('inert')

    // Collapse: same control flips to a reopen affordance and the content goes inert.
    fireEvent.click(toggle)
    const reopen = screen.getByRole('button', { name: /show trip details/i })
    expect(reopen).toHaveAttribute('aria-expanded', 'false')
    expect(document.getElementById('trip-details-scroll')).toHaveAttribute('inert')

    // Reopen from the very same control — closing is never a dead end.
    fireEvent.click(reopen)
    expect(screen.getByRole('button', { name: /hide trip details/i })).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById('trip-details-scroll')).not.toHaveAttribute('inert')
  })

  // This route sits outside the (shell) layout (no sidebar), so the panel must carry its own
  // up-nav back to the trips list — otherwise an opened trip is a dead end with no way home.
  it('offers an up-nav link back to the trips list', async () => {
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    renderWorkspace(TOKYO_TRIP.trip.id)
    const back = await screen.findByRole('link', { name: /all trails/i })
    expect(back).toHaveAttribute('href', '/app/trips')
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

  // Hotel-hub map (plan 2026-08-04-hotel-hub-map, T8). Route ⇄ Hotel is a single segmented
  // control; the mode is observable through each segment's aria-pressed state.
  it('toggles the map layer between route and hotel', async () => {
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    renderWorkspace(TOKYO_TRIP.trip.id)
    const hotelBtn = await screen.findByRole('button', { name: /^hotel$/i })
    const routeBtn = screen.getByRole('button', { name: /^route$/i })
    expect(routeBtn).toHaveAttribute('aria-pressed', 'true')
    expect(hotelBtn).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(hotelBtn)
    expect(hotelBtn).toHaveAttribute('aria-pressed', 'true')
    expect(routeBtn).toHaveAttribute('aria-pressed', 'false')
  })

  // C5: no hotel got a coordinate ⇒ the hub layer has nothing to draw, so the Hotel segment is
  // disabled rather than flipping to a silently blank map.
  it('disables the hotel layer when no hotel could be placed', async () => {
    const allUnresolved: TripBundle = {
      ...TOKYO_TRIP,
      hotels: TOKYO_TRIP.hotels.map((h) => ({
        ...h, geo_status: 'unresolved' as const, is_recommended: false, rank: null, lat: null, lng: null,
      })),
    }
    getTrip.mockResolvedValueOnce(allUnresolved)
    renderWorkspace(TOKYO_TRIP.trip.id)
    expect(await screen.findByRole('button', { name: /^hotel$/i })).toBeDisabled()
  })

  // Merge-lite (2026-08-06): ONE hotel decision surface. The price-vs-rating card renders exactly
  // once (inside "Where to stay", not also at the top), and the pacing notes render as "Heads up".
  it('renders the price-vs-rating card once, with pacing notes under Heads up', async () => {
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    renderWorkspace(TOKYO_TRIP.trip.id)
    await screen.findByRole('heading', { name: 'Price vs rating' })
    expect(screen.getAllByRole('heading', { name: 'Price vs rating' })).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'Heads up' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Tradeoffs' })).not.toBeInTheDocument()
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

  // Feedback mount (plan T3). The panel appears ONLY on the explicit allowlist — completed
  // surfaces plus the failed screen — never on whatever status merely reaches the main return.
  // TOKYO_TRIP itself is `saved_with_gaps`, so `complete` has to be seeded explicitly.
  function bundleWith(status: TripBundle['trip']['status']): TripBundle {
    return { ...TOKYO_TRIP, trip: { ...TOKYO_TRIP.trip, status } }
  }

  it('mounts the feedback panel on complete trips', async () => {
    getTrip.mockResolvedValueOnce(bundleWith('complete'))
    renderWorkspace(TOKYO_TRIP.trip.id)
    expect(await screen.findByTestId('trip-feedback-panel')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /how was this trail/i })).toBeInTheDocument()
  })

  it('mounts the feedback panel on saved_with_gaps trips', async () => {
    getTrip.mockResolvedValueOnce(bundleWith('saved_with_gaps'))
    renderWorkspace(TOKYO_TRIP.trip.id)
    expect(await screen.findByTestId('trip-feedback-panel')).toBeInTheDocument()
  })

  // places_ready falls THROUGH to the normal workspace return, so this proves the gate is an
  // explicit allowlist, not "whatever reaches the main return".
  it('hides the feedback panel on places_ready trips', async () => {
    getTrip.mockResolvedValueOnce(bundleWith('places_ready'))
    renderWorkspace(TOKYO_TRIP.trip.id)
    await screen.findByRole('link', { name: /all trails/i })
    expect(screen.queryByTestId('trip-feedback-panel')).not.toBeInTheDocument()
  })

  it('mounts the feedback panel on the failed screen, beside the failure copy', async () => {
    getTrip.mockResolvedValueOnce(bundleWith('failed'))
    renderWorkspace(TOKYO_TRIP.trip.id)
    expect(await screen.findByText(/generation failed/i)).toBeInTheDocument()
    expect(screen.getByText(/tell us what went wrong/i)).toBeInTheDocument()
    expect(screen.getByTestId('trip-feedback-panel')).toBeInTheDocument()
  })

  it('hides the feedback panel while generating', async () => {
    getTrip.mockResolvedValueOnce(bundleWith('generating'))
    renderWorkspace(TOKYO_TRIP.trip.id)
    await screen.findByText(/still generating/i)
    expect(screen.queryByTestId('trip-feedback-panel')).not.toBeInTheDocument()
  })

  it('hides the feedback panel while draft', async () => {
    getTrip.mockResolvedValueOnce(bundleWith('draft'))
    renderWorkspace(TOKYO_TRIP.trip.id)
    await screen.findByText(/still generating/i)
    expect(screen.queryByTestId('trip-feedback-panel')).not.toBeInTheDocument()
  })

  // Codex r1 low: the panel binds to the LOADED bundle's trip id, never the route param.
  it('passes the loaded bundle trip id to the panel, not the route param', async () => {
    getTrip.mockResolvedValueOnce({ ...TOKYO_TRIP, trip: { ...TOKYO_TRIP.trip, id: 'bundle-trip-id' } })
    renderWorkspace('route-param-id')
    expect(await screen.findByTestId('trip-feedback-panel')).toHaveTextContent('bundle-trip-id')
  })
})
