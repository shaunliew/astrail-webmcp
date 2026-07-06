// components/trip/__tests__/ItineraryCards.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ItineraryCards from '@/components/trip/ItineraryCards'
import { placesForDay } from '@/lib/trip/selectors'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

const day1 = placesForDay(TOKYO_TRIP, 1)

describe('ItineraryCards', () => {
  it('renders a card per place with its name and source badge', () => {
    render(<ItineraryCards places={day1} selectedPlaceId={null} onSelectPlace={() => {}} />)
    for (const tp of day1) {
      expect(screen.getByText(tp.place.name)).toBeInTheDocument()
    }
  })

  it('shows an evidence chip (confidence %) for every place', () => {
    render(<ItineraryCards places={day1} selectedPlaceId={null} onSelectPlace={() => {}} />)
    const pct = `${Math.round(day1[0].evidence_json.confidence * 100)}%`
    expect(screen.getAllByText(pct).length).toBeGreaterThan(0)
  })

  it('calls onSelectPlace with the place_id when a card is clicked', () => {
    const onSelectPlace = vi.fn()
    render(<ItineraryCards places={day1} selectedPlaceId={null} onSelectPlace={onSelectPlace} />)
    fireEvent.click(screen.getByText(day1[0].place.name))
    expect(onSelectPlace).toHaveBeenCalledWith(day1[0].place_id)
  })

  it('marks the selected card', () => {
    render(<ItineraryCards places={day1} selectedPlaceId={day1[0].place_id} onSelectPlace={() => {}} />)
    expect(screen.getByRole('button', { name: new RegExp(day1[0].place.name, 'i') }))
      .toHaveAttribute('aria-current', 'true')
  })
})
