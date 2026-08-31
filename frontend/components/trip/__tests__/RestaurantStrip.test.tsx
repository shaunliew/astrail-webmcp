import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import RestaurantStrip from '@/components/trip/RestaurantStrip'
import { restaurantsForDay, buildPlaceIndex } from '@/lib/trip/selectors'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

const idx = buildPlaceIndex(TOKYO_TRIP)

describe('RestaurantStrip', () => {
  it('renders each restaurant with its summary', () => {
    const rests = restaurantsForDay(TOKYO_TRIP, TOKYO_TRIP.restaurants[0].trip_day_id!)
    render(<RestaurantStrip restaurants={rests} placeIndex={idx} />)
    expect(screen.getByText(new RegExp(rests[0].summary.slice(0, 12), 'i'))).toBeInTheDocument()
  })

  it('renders an empty-state when there are no restaurants', () => {
    render(<RestaurantStrip restaurants={[]} placeIndex={idx} />)
    expect(screen.getByText(/Astrail didn.t find restaurants near this route yet/i)).toBeInTheDocument()
  })
})
