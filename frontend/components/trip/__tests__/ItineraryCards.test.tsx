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

  // A pin tap (or the agent's show_on_map) changes selectedPlaceId from outside this list.
  // On mobile that used to be invisible: the map's evidence popup lives inside `.shared-map`,
  // which is `position: fixed; z-index: 0` — its own stacking context — so it can never paint
  // above the z-10 details sheet covering most of a phone screen. Scrolling the matching card
  // into view is the surface that IS visible there.
  it('brings a place selected from the map into view', () => {
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView')
    const view = render(
      <ItineraryCards places={day1} selectedPlaceId={null} onSelectPlace={() => {}} />,
    )
    expect(spy).not.toHaveBeenCalled()   // nothing selected yet — no unprompted scrolling

    const target = day1[1] ?? day1[0]
    view.rerender(
      <ItineraryCards places={day1} selectedPlaceId={target.place_id} onSelectPlace={() => {}} />,
    )
    expect(spy).toHaveBeenCalledTimes(1)
    // The element scrolled must be the card for THAT place, not merely some card.
    expect((spy.mock.contexts[0] as HTMLElement).dataset.placeId).toBe(target.place_id)
    // 'nearest', so clicking a card already on screen never jolts the list under the cursor.
    expect(spy.mock.calls[0][0]).toMatchObject({ block: 'nearest' })
    spy.mockRestore()
  })

  it('marks the selected card', () => {
    render(<ItineraryCards places={day1} selectedPlaceId={day1[0].place_id} onSelectPlace={() => {}} />)
    expect(screen.getByRole('button', { name: new RegExp(day1[0].place.name, 'i') }))
      .toHaveAttribute('aria-current', 'true')
  })
})
