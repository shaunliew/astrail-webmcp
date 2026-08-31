import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import TransportStrip from '@/components/trip/TransportStrip'
import { legsForDay, buildPlaceIndex } from '@/lib/trip/selectors'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

const idx = buildPlaceIndex(TOKYO_TRIP)

describe('TransportStrip', () => {
  it('renders each leg with from → to place names', () => {
    const legs = legsForDay(TOKYO_TRIP, 'day_1')
    render(<TransportStrip legs={legs} placeIndex={idx} />)
    const from = idx.get(legs[0].from_place_id!)!.name
    expect(screen.getByText(new RegExp(from, 'i'))).toBeInTheDocument()
  })

  it('surfaces the warning for a no_route leg instead of a duration', () => {
    // Follows the baked no_route leg (PRD §17) to whichever day holds it, rather than naming a
    // day id — the trip was consolidated from three days to two and 'day_3' stopped existing.
    const noRoute = TOKYO_TRIP.transport_legs.find((l) => l.status === 'no_route')!
    const legs = legsForDay(TOKYO_TRIP, noRoute.trip_day_id!)
    render(<TransportStrip legs={legs} placeIndex={idx} />)
    expect(screen.getByText(/public transit may be preferable/i)).toBeInTheDocument()
  })

  it('renders the composed empty state when there are no legs', () => {
    render(<TransportStrip legs={[]} placeIndex={idx} />)
    expect(screen.getByText(/no route legs for this day/i)).toBeInTheDocument()
  })
})
