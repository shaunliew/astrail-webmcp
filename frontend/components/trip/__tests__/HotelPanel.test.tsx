import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import HotelPanel from '@/components/trip/HotelPanel'
import { tripHotels } from '@/lib/trip/selectors'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

describe('HotelPanel', () => {
  it('renders each hotel name', () => {
    render(<HotelPanel hotels={tripHotels(TOKYO_TRIP)} />)
    expect(screen.getByText(tripHotels(TOKYO_TRIP)[0].name)).toBeInTheDocument()
  })

  it('shows a skipped state for a skipped hotel', () => {
    const skipped = tripHotels(TOKYO_TRIP).find((h) => h.status === 'skipped')!
    render(<HotelPanel hotels={[skipped]} />)
    expect(screen.getByText(/skipped/i)).toBeInTheDocument()
  })

  it('renders the composed empty state when there are no hotels', () => {
    render(<HotelPanel hotels={[]} />)
    expect(screen.getByText(/no hotel suggestions for these dates/i)).toBeInTheDocument()
  })
})
