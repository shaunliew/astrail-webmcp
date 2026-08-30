// components/trip/__tests__/ItineraryCards.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import ItineraryCards from '@/components/trip/ItineraryCards'
import { placesForDay, legsForDay, buildPlaceIndex } from '@/lib/trip/selectors'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

const day1 = placesForDay(TOKYO_TRIP, 1)
const day1Legs = legsForDay(TOKYO_TRIP, 'day_1')
const day3 = placesForDay(TOKYO_TRIP, 3)
const day3Legs = legsForDay(TOKYO_TRIP, 'day_3')
const idx = buildPlaceIndex(TOKYO_TRIP)

describe('ItineraryCards', () => {
  it('renders a card per place with its name and source badge', () => {
    render(<ItineraryCards places={day1} selectedPlaceId={null} onSelectPlace={() => {}} />)
    for (const tp of day1) {
      expect(screen.getByText(tp.place.name)).toBeInTheDocument()
    }
  })

  /* Sequence has to be READABLE, not merely implied by document order — the panel's whole job is
     answering "where do I go first". A screen reader (and any test) can hold this to account:
     each stop says its own position, attached to its own heading. A CSS rail proves nothing. */
  it('states each stop position in the markup, bound to that stop heading', () => {
    render(<ItineraryCards places={day1} selectedPlaceId={null} onSelectPlace={() => {}} />)
    expect(screen.getByRole('list').tagName).toBe('OL')
    const steps = screen.getAllByRole('listitem')
    expect(steps).toHaveLength(day1.length)
    steps.forEach((li, i) => {
      expect(within(li).getByText(`Stop ${i + 1} of ${day1.length}`)).toBeInTheDocument()
      expect(within(li).getByRole('heading')).toHaveTextContent(day1[i].place.name)
    })
  })

  // Pin numbers are the shared vocabulary of the map, the user and the WebMCP tools — the
  // redesign moves where they sit, never what they say.
  it('keeps the zero-padded pin number on every stop', () => {
    render(<ItineraryCards places={day1} selectedPlaceId={null} onSelectPlace={() => {}} />)
    day1.forEach((_, i) => {
      expect(screen.getByText(String(i + 1).padStart(2, '0'))).toBeInTheDocument()
    })
  })

  it('shows an evidence chip on every stop, not merely somewhere on the page', () => {
    render(<ItineraryCards places={day1} selectedPlaceId={null} onSelectPlace={() => {}} />)
    screen.getAllByRole('listitem').forEach((li, i) => {
      const pct = `${Math.round(day1[i].evidence_json.confidence * 100)}%`
      expect(within(li).getByText(pct)).toBeInTheDocument()
    })
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

  describe('route links', () => {
    /* The leg belongs WITH the two stops it joins, and it has to be read BEFORE the stop it
       delivers you to — "Akasaka Station → 3 min walk → Harry Potter Cafe" is a direction;
       the same leg parked in a separate section further down the page is a lookup. */
    it('folds the arriving leg in above the stop it delivers you to', () => {
      render(
        <ItineraryCards
          places={day1} legs={day1Legs} placeIndex={idx}
          selectedPlaceId={null} onSelectPlace={() => {}}
        />,
      )
      const steps = screen.getAllByRole('listitem')
      expect(steps[1]).toHaveTextContent(/walk/i)
      expect(steps[1]).toHaveTextContent('3 min')      // leg_1 is 150 s
      expect(steps[1]).toHaveTextContent('0.1 km')     // …and 130 m
      // Read in order, the leg comes before the stop it arrives at.
      const text = steps[1].textContent ?? ''
      expect(text.indexOf('3 min')).toBeGreaterThanOrEqual(0)
      expect(text.indexOf('3 min')).toBeLessThan(text.indexOf(day1[1].place.name))
      // …and it is NOT also printed against the stop you are leaving.
      expect(steps[0]).not.toHaveTextContent('3 min')
    })

    /* Day 3's only leg starts on day 2 (Ichiran → Disneyland), so a naive "leg between two
       consecutive stops in this list" fold would drop it — and with it the day's routing
       warning. This is the case that makes removing the separate "Getting around" section
       lossless, so it is pinned. */
    it('shows a leg arriving from another day above the first stop, warning and all', () => {
      render(
        <ItineraryCards
          places={day3} legs={day3Legs} placeIndex={idx}
          selectedPlaceId={null} onSelectPlace={() => {}}
        />,
      )
      const [li] = screen.getAllByRole('listitem')
      const origin = idx.get('pl_ichiran')!.name
      expect(li).toHaveTextContent(/public transit may be preferable/i)
      expect(li).toHaveTextContent(origin)   // names where you set off from
      /* And it is read on the way IN, not as a footnote after you have arrived. Without this the
         test passes on a fold that misses the leg entirely and falls back to trailing it. */
      const text = li.textContent ?? ''
      expect(text.indexOf(origin)).toBeLessThan(text.indexOf(day3[0].place.name))
    })

    // Most saved trips carry no legs at all. The route must still read as a route.
    it('still renders every stop, in sequence, when the day has no legs', () => {
      render(<ItineraryCards places={day1} legs={[]} placeIndex={idx} selectedPlaceId={null} onSelectPlace={() => {}} />)
      const steps = screen.getAllByRole('listitem')
      expect(steps).toHaveLength(day1.length)
      steps.forEach((li, i) => {
        expect(within(li).getByText(`Stop ${i + 1} of ${day1.length}`)).toBeInTheDocument()
      })
    })
  })
})
