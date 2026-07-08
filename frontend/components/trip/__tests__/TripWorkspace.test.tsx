import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
import { placesForDay } from '@/lib/trip/selectors'

const { getTrip } = vi.hoisted(() => ({ getTrip: vi.fn() }))

vi.mock('@/lib/trip/supabase-api', () => ({ getTrip }))
vi.mock('@/components/map/TripMap', () => ({ default: () => <div data-testid="trip-map" /> }))

import TripWorkspace from '@/components/trip/TripWorkspace'

describe('TripWorkspace', () => {
  beforeEach(() => { getTrip.mockReset() })

  it('loads the trip and renders day-1 places', async () => {
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    render(<TripWorkspace tripId={TOKYO_TRIP.trip.id} />)
    const firstDay1Place = placesForDay(TOKYO_TRIP, 1)[0].place.name
    expect(await screen.findByText(firstDay1Place)).toBeInTheDocument()
    expect(await screen.findByTestId('trip-map')).toBeInTheDocument()
  })

  it('switching days swaps the visible places', async () => {
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    render(<TripWorkspace tripId={TOKYO_TRIP.trip.id} />)
    const day3Place = placesForDay(TOKYO_TRIP, 3)[0].place.name
    // wait for load
    await screen.findByRole('tab', { name: /day 3/i })
    fireEvent.click(screen.getByRole('tab', { name: /day 3/i }))
    await waitFor(() => expect(screen.getByText(day3Place)).toBeInTheDocument())
  })

  it('shows a not-found state for an unknown trip id', async () => {
    getTrip.mockResolvedValueOnce(null)
    render(<TripWorkspace tripId="does_not_exist" />)
    expect(await screen.findByText(/not found/i)).toBeInTheDocument()
  })

  it('shows the failed state for failed trips', async () => {
    getTrip.mockResolvedValueOnce({ ...TOKYO_TRIP, trip: { ...TOKYO_TRIP.trip, status: 'failed' } })
    render(<TripWorkspace tripId={TOKYO_TRIP.trip.id} />)
    expect(await screen.findByText(/generation failed/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /plan a new trip/i })).toHaveAttribute('href', '/app')
  })

  it('shows the generating state for in-progress trips', async () => {
    getTrip.mockResolvedValueOnce({ ...TOKYO_TRIP, trip: { ...TOKYO_TRIP.trip, status: 'generating' } })
    render(<TripWorkspace tripId={TOKYO_TRIP.trip.id} />)
    expect(await screen.findByText(/still generating/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument()
  })
})
