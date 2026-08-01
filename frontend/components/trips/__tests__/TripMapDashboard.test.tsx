import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'

const { mapInstance, MarkerCtor, BoundsCtor } = vi.hoisted(() => {
  const mapInstance = {
    on: vi.fn(), off: vi.fn(),
    getCenter: vi.fn(() => ({ lng: 100, lat: 20 })),
    setCenter: vi.fn(),
    flyTo: vi.fn(), fitBounds: vi.fn(), easeTo: vi.fn(),
  }
  const MarkerCtor = vi.fn(() => {
    const marker = { setLngLat: vi.fn(() => marker), addTo: vi.fn(() => marker), remove: vi.fn() }
    return marker
  })
  const BoundsCtor = vi.fn(() => ({ extend: vi.fn() }))
  return { mapInstance, MarkerCtor, BoundsCtor }
})
vi.mock('mapbox-gl', () => ({ default: { Marker: MarkerCtor, LngLatBounds: BoundsCtor } }))

const shared = vi.hoisted(() => ({
  hasToken: true,
  ready: true,
  getMap: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  setMarkers: vi.fn(),
  setLightPreset: vi.fn(),
}))
vi.mock('@/components/map/MapProvider', () => ({ useSharedMap: () => shared }))

const { getTrip } = vi.hoisted(() => ({ getTrip: vi.fn() }))
vi.mock('@/lib/trip/supabase-api', () => ({ getTrip }))

const { markTripFramed } = vi.hoisted(() => ({ markTripFramed: vi.fn() }))
vi.mock('@/lib/trip/map-handoff', () => ({ markTripFramed }))

import TripMapDashboard from '@/components/trips/TripMapDashboard'

// A stand-in for the measured right-hand window.
const windowRef = {
  current: { getBoundingClientRect: () => ({ top: 0, bottom: 800, left: 592, right: 1440 }) },
} as unknown as React.RefObject<HTMLElement | null>

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

describe('TripMapDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    shared.hasToken = true
    shared.ready = true
    shared.getMap.mockReturnValue(mapInstance)
    // The idle spin schedules rAF; keep it inert so tests observe the one-shot framing
    // without the animation loop running.
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })
  afterEach(() => vi.unstubAllGlobals())

  it('acquires the shared map dawn-lit on mount and releases on unmount', () => {
    const { unmount } = render(<TripMapDashboard selectedTripId={null} windowRef={windowRef} />)
    expect(shared.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ interactive: true, lightPreset: 'dawn' }),
    )
    expect(shared.release).not.toHaveBeenCalled()
    unmount()
    expect(shared.release).toHaveBeenCalledTimes(1)
  })

  it('frames the whole globe into the window while nothing is selected', () => {
    render(<TripMapDashboard selectedTripId={null} windowRef={windowRef} />)
    // Idle first settles the globe (instant easeTo, duration 0) before the gentle spin.
    expect(mapInstance.easeTo).toHaveBeenCalledWith(
      expect.objectContaining({ duration: 0, pitch: 0 }),
    )
  })

  it('drops a pin per resolved place and flies into the trip on selection', async () => {
    getTrip.mockResolvedValueOnce({
      places: [
        { place_id: 'a', place: { lng: 139.70, lat: 35.66 } },
        { place_id: 'b', place: { lng: 135.50, lat: 34.69 } },
      ],
    })
    render(<TripMapDashboard selectedTripId="trip-1" windowRef={windowRef} />)
    await flush()

    expect(getTrip).toHaveBeenCalledWith('trip-1')
    expect(MarkerCtor).toHaveBeenCalledTimes(2)
    expect(shared.setMarkers).toHaveBeenCalled()
    expect(mapInstance.fitBounds).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pitch: 45, maxZoom: 13 }),
    )
    // Marks the handoff so the workspace can settle in seamlessly on "Open trip".
    expect(markTripFramed).toHaveBeenCalledWith('trip-1')
  })

  it('does not frame to (0,0) for a coords-less trip; shows a "no mapped places" note', async () => {
    getTrip.mockResolvedValueOnce({ places: [{ place_id: 'x', place: { lng: 0, lat: 0 } }] })
    render(<TripMapDashboard selectedTripId="trip-2" windowRef={windowRef} />)
    await flush()

    expect(mapInstance.fitBounds).not.toHaveBeenCalled()
    expect(mapInstance.flyTo).not.toHaveBeenCalled()
    expect(screen.getByText(/no mapped places/i)).toBeInTheDocument()
  })

  it('shows a fallback when the Mapbox token is missing', () => {
    shared.hasToken = false
    render(<TripMapDashboard selectedTripId={null} windowRef={windowRef} />)
    expect(screen.getByText(/map unavailable/i)).toBeInTheDocument()
  })
})
