import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import TripWorkspace from '@/components/trip/TripWorkspace'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
import { placesForDay } from '@/lib/trip/selectors'

vi.mock('@/components/map/TripMap', () => ({ default: () => <div data-testid="trip-map" /> }))

describe('TripWorkspace', () => {
  it('loads the trip and renders day-1 places', async () => {
    render(<TripWorkspace tripId={TOKYO_TRIP.trip.id} />)
    const firstDay1Place = placesForDay(TOKYO_TRIP, 1)[0].place.name
    expect(await screen.findByText(firstDay1Place)).toBeInTheDocument()
    expect(await screen.findByTestId('trip-map')).toBeInTheDocument()
  })

  it('switching days swaps the visible places', async () => {
    render(<TripWorkspace tripId={TOKYO_TRIP.trip.id} />)
    const day3Place = placesForDay(TOKYO_TRIP, 3)[0].place.name
    // wait for load
    await screen.findByRole('tab', { name: /day 3/i })
    fireEvent.click(screen.getByRole('tab', { name: /day 3/i }))
    await waitFor(() => expect(screen.getByText(day3Place)).toBeInTheDocument())
  })

  it('shows a not-found state for an unknown trip id', async () => {
    render(<TripWorkspace tripId="does_not_exist" />)
    expect(await screen.findByText(/not found/i)).toBeInTheDocument()
  })
})
