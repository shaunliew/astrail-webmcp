import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
import { placesForDay } from '@/lib/trip/selectors'

/**
 * `/app/trip/demo` — the read-only sample trail.
 *
 * The submission's claim is that only a tool running IN the page can move the 3D map a human is
 * looking at. Until this route existed, seeing that cost a sign-in and a 60-180s generation. This
 * asserts the one thing the route has to get right: the fixture reaches the workspace, and no
 * network read is involved in getting it there.
 */

const { getTrip, mapInstance, MapCtor } = vi.hoisted(() => {
  const handler = () => ({ enable: vi.fn(), disable: vi.fn() })
  return {
    getTrip: vi.fn(),
    MapCtor: vi.fn(),
    mapInstance: {
      on: vi.fn(), setConfigProperty: vi.fn(), remove: vi.fn(), resize: vi.fn(), stop: vi.fn(),
      style: { setTransition: vi.fn() },
      scrollZoom: handler(), boxZoom: handler(), dragRotate: handler(), dragPan: handler(),
      keyboard: handler(), doubleClickZoom: handler(), touchZoomRotate: handler(), touchPitch: handler(),
    },
  }
})

vi.mock('@/lib/trip/supabase-api', () => ({ getTrip }))
vi.mock('@/components/map/TripMap', () => ({ default: () => <div data-testid="trip-map" /> }))
vi.mock('mapbox-gl', () => ({
  default: { Map: MapCtor.mockReturnValue(mapInstance), Marker: vi.fn(), LngLatBounds: vi.fn(), accessToken: '' },
}))
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}))
vi.mock('@/components/trip/TripFeedbackPanel', () => ({
  default: () => <div data-testid="trip-feedback-panel" />,
}))

const { default: MapProvider } = await import('@/components/map/MapProvider')
const { default: DemoTripPage } = await import('../page')

describe('/app/trip/demo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN = 'pk.test'
  })
  afterEach(() => { delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN })

  it('renders the Tokyo sample on a real map, with no account and no fetch', async () => {
    render(<MapProvider><DemoTripPage /></MapProvider>)

    expect(await screen.findByText(placesForDay(TOKYO_TRIP, 1)[0].place.name)).toBeInTheDocument()
    expect(await screen.findByTestId('trip-map')).toBeInTheDocument()
    expect(screen.getByText(/sample trail — read-only/i)).toBeInTheDocument()
    expect(getTrip).not.toHaveBeenCalled()
    // Nothing on this page writes, so the composer that posts feedback for a trip id stays off.
    expect(screen.queryByTestId('trip-feedback-panel')).not.toBeInTheDocument()
  })
})
