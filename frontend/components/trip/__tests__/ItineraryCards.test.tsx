// components/trip/__tests__/ItineraryCards.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import ItineraryCards from '@/components/trip/ItineraryCards'
import { thumbnailFor } from '@/components/map/popup-model'
import type { TripPlace } from '@/lib/trip/backend-types'
import { placesForDay, legsForDay, buildPlaceIndex, buildTrailNumbers } from '@/lib/trip/selectors'
import { resolvePlaceRef } from '@/lib/webmcp/resolve'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

const day1 = placesForDay(TOKYO_TRIP, 1)
const day2 = placesForDay(TOKYO_TRIP, 2)
const day3 = placesForDay(TOKYO_TRIP, 3)
const day1Legs = legsForDay(TOKYO_TRIP, 'day_1')
const day3Legs = legsForDay(TOKYO_TRIP, 'day_3')
const idx = buildPlaceIndex(TOKYO_TRIP)
/* The SAME numbering the map paints and `resolvePlaceRef` answers to — not a copy of it. */
const PINS = buildTrailNumbers(TOKYO_TRIP)
const ALL_PLACES = [...day1, ...day2, ...day3]

describe('ItineraryCards', () => {
  it('renders a card per place with its name and source badge', () => {
    render(<ItineraryCards places={day1} trailNumbers={PINS} selectedPlaceId={null} onSelectPlace={() => {}} />)
    for (const tp of day1) {
      expect(screen.getByText(tp.place.name)).toBeInTheDocument()
    }
  })

  /* Sequence has to be READABLE, not merely implied by document order — the panel's whole job is
     answering "where do I go first". A screen reader (and any test) can hold this to account:
     each stop says its own position, attached to its own heading. A CSS rail proves nothing. */
  it('states each stop position in the markup, bound to that stop heading', () => {
    render(<ItineraryCards places={day1} trailNumbers={PINS} selectedPlaceId={null} onSelectPlace={() => {}} />)
    expect(screen.getByRole('list').tagName).toBe('OL')
    const steps = screen.getAllByRole('listitem')
    expect(steps).toHaveLength(day1.length)
    steps.forEach((li, i) => {
      expect(within(li).getByText(`Stop ${PINS.get(day1[i].id)} of ${PINS.size}`)).toBeInTheDocument()
      expect(within(li).getByRole('heading')).toHaveTextContent(day1[i].place.name)
    })
  })

  it('shows an evidence chip on every stop, not merely somewhere on the page', () => {
    render(<ItineraryCards places={day1} trailNumbers={PINS} selectedPlaceId={null} onSelectPlace={() => {}} />)
    screen.getAllByRole('listitem').forEach((li, i) => {
      const pct = `${Math.round(day1[i].evidence_json.confidence * 100)}%`
      expect(within(li).getByText(pct)).toBeInTheDocument()
    })
  })

  it('calls onSelectPlace with the place_id when a card is clicked', () => {
    const onSelectPlace = vi.fn()
    render(<ItineraryCards places={day1} trailNumbers={PINS} selectedPlaceId={null} onSelectPlace={onSelectPlace} />)
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
      <ItineraryCards places={day1} trailNumbers={PINS} selectedPlaceId={null} onSelectPlace={() => {}} />,
    )
    expect(spy).not.toHaveBeenCalled()   // nothing selected yet — no unprompted scrolling

    const target = day1[1] ?? day1[0]
    view.rerender(
      <ItineraryCards places={day1} trailNumbers={PINS} selectedPlaceId={target.place_id} onSelectPlace={() => {}} />,
    )
    expect(spy).toHaveBeenCalledTimes(1)
    // The element scrolled must be the card for THAT place, not merely some card.
    expect((spy.mock.contexts[0] as HTMLElement).dataset.placeId).toBe(target.place_id)
    // 'nearest', so clicking a card already on screen never jolts the list under the cursor.
    expect(spy.mock.calls[0][0]).toMatchObject({ block: 'nearest' })
    spy.mockRestore()
  })

  it('marks the selected card', () => {
    render(<ItineraryCards places={day1} trailNumbers={PINS} selectedPlaceId={day1[0].place_id} onSelectPlace={() => {}} />)
    expect(screen.getByRole('button', { name: new RegExp(day1[0].place.name, 'i') }))
      .toHaveAttribute('aria-current', 'true')
  })

  /* `aria-current` alone is not the selected state — a sighted user has to SEE which stop the map
     is showing. The card cannot carry that with a Tailwind `border-[var(--brass)]` utility: the
     scoped `.paper-scope .surface` rule in globals.css is unlayered, so it out-ranks every layered
     single-class utility and silently swallows the border (globals.css says exactly this, and
     ships `.surface--selected` because it already happened once on the hotel picker). Utilities
     that lose leave no error and no failing test — only a state nobody can see. So the contract is
     asserted on BOTH sides: the markup asks for the modifier, and the stylesheet still defines it. */
  it('paints selection with a modifier the stylesheet actually defines', async () => {
    const { readFileSync } = await import('node:fs')
    const css = readFileSync('app/globals.css', 'utf8')
    expect(css).toMatch(/\.surface\.surface--selected\s*\{/)
    expect(css).toMatch(/\.surface--hoverable:hover/)

    render(<ItineraryCards places={day1} trailNumbers={PINS} selectedPlaceId={day1[0].place_id} onSelectPlace={() => {}} />)
    const selected = screen.getByRole('button', { name: new RegExp(day1[0].place.name, 'i') })
    expect(selected.className).toContain('surface--selected')
    expect(selected.className).not.toContain('surface--hoverable')

    const other = screen.getByRole('button', { name: new RegExp(day1[1].place.name, 'i') })
    expect(other.className).toContain('surface--hoverable')
    expect(other.className).not.toContain('surface--selected')
  })

  /* Pin numbers are one shared vocabulary across the map, the panel, the user and the WebMCP
     tools. Two schemes under one name is a silent wrong-stop bug, not a cosmetic mismatch: a
     user reading "01" beside SANDO LAB and saying "move stop 1" moves Akasaka Station instead,
     and the agent confirms it did what was asked. Day 2 is where a per-day count and the trail
     numbering disagree, so every assertion here is made against day 2. */
  describe('pin numbers', () => {
    it('labels each stop with the trail number, not a count that restarts each day', () => {
      // If the fixture ever stops disagreeing, these tests stop testing anything. Say so loudly.
      expect(PINS.get(day2[0].id)).not.toBe(1)

      render(<ItineraryCards places={day2} trailNumbers={PINS} selectedPlaceId={null} onSelectPlace={() => {}} />)
      const steps = screen.getAllByRole('listitem')
      day2.forEach((tp, i) => {
        const pin = PINS.get(tp.id)!
        expect(within(steps[i]).getByText(String(pin).padStart(2, '0'))).toBeInTheDocument()
      })
    })

    /* The end-to-end contract, read in the direction the user meets it: take the number the
       PANEL actually painted, hand it to the agent's own resolver, and require the same stop
       back. Nothing here restates a number a human typed twice. */
    it('labels a stop with the number resolvePlaceRef answers to', () => {
      const { container } = render(
        <ItineraryCards places={day2} trailNumbers={PINS} selectedPlaceId={null} onSelectPlace={() => {}} />,
      )
      for (const tp of day2) {
        const card = container.querySelector<HTMLElement>(`[data-place-id="${tp.place_id}"]`)!
        const painted = within(card).getByText(/^\d+$/).textContent!   // what the user reads
        const resolved = resolvePlaceRef(TOKYO_TRIP, painted)          // what the agent moves
        expect(resolved.ok).toBe(true)
        expect(resolved.ok && resolved.tripPlace.id).toBe(tp.id)
      }
    })

    /* A stop with unresolved coordinates gets no map pin and cannot be addressed by number
       (`orderedTripPlaces` drops it). Printing a number beside it would be inventing a handle
       that resolves to a different stop — the exact failure this whole block exists to stop. */
    it('leaves a stop the map cannot pin unnumbered rather than inventing one', () => {
      const unpinned = day2[1]
      const partial = new Map([...PINS].filter(([id]) => id !== unpinned.id))
      const { container } = render(
        <ItineraryCards places={day2} trailNumbers={partial} selectedPlaceId={null} onSelectPlace={() => {}} />,
      )
      const card = container.querySelector<HTMLElement>(`[data-place-id="${unpinned.place_id}"]`)!
      expect(within(card).queryByText(/^\d+$/)).toBeNull()
      expect(card).toHaveTextContent(unpinned.place.name)      // still a stop, still readable
      expect(card).toHaveTextContent(/unnumbered stop/i)       // and honest about why
    })
  })

  describe('route links', () => {
    /* The leg belongs WITH the two stops it joins, and it has to be read BEFORE the stop it
       delivers you to — "Akasaka Station → 3 min walk → Harry Potter Cafe" is a direction;
       the same leg parked in a separate section further down the page is a lookup. */
    it('folds the arriving leg in above the stop it delivers you to', () => {
      render(
        <ItineraryCards
          places={day1} legs={day1Legs} placeIndex={idx} trailNumbers={PINS}
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
          places={day3} legs={day3Legs} placeIndex={idx} trailNumbers={PINS}
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
      render(
        <ItineraryCards
          places={day1} legs={[]} placeIndex={idx} trailNumbers={PINS}
          selectedPlaceId={null} onSelectPlace={() => {}}
        />,
      )
      const steps = screen.getAllByRole('listitem')
      expect(steps).toHaveLength(day1.length)
      steps.forEach((li, i) => {
        expect(within(li).getByText(`Stop ${PINS.get(day1[i].id)} of ${PINS.size}`)).toBeInTheDocument()
      })
    })
  })
})

/* ── Covers ───────────────────────────────────────────────────────────────────────────────
   `thumbnailFor` is null for every stop that did NOT come from a Reel, which on a real trail
   is a large minority. The panel must draw something honest there rather than a broken <img>
   or a generic grey square: the absence IS information — nothing was pulled from a Reel. */
describe('ItineraryCards covers', () => {
  const dayOf = (tp: TripPlace) => placesForDay(TOKYO_TRIP, tp.day_number!)

  it('shows the reel cover on a stop that came from a reel', () => {
    const withCover = ALL_PLACES.find((tp) => thumbnailFor(TOKYO_TRIP, tp))
    // If the fixture ever loses its covered stops this asserts nothing. Fail loudly instead.
    expect(withCover, 'fixture has no reel-covered stop — this test proves nothing').toBeDefined()
    const { container } = render(
      <ItineraryCards
        bundle={TOKYO_TRIP} places={dayOf(withCover!)} trailNumbers={PINS}
        selectedPlaceId={null} onSelectPlace={() => {}}
      />,
    )
    const card = container.querySelector<HTMLElement>(`[data-place-id="${withCover!.place_id}"]`)!
    expect(card.querySelector('img')).toHaveAttribute('src', thumbnailFor(TOKYO_TRIP, withCover!))
  })

  it('draws a placeholder, not a broken image, for a stop with no reel behind it', () => {
    const noCover = ALL_PLACES.find((tp) => !thumbnailFor(TOKYO_TRIP, tp))
    expect(noCover, 'fixture has no uncovered stop — this test proves nothing').toBeDefined()
    const { container } = render(
      <ItineraryCards
        bundle={TOKYO_TRIP} places={dayOf(noCover!)} trailNumbers={PINS}
        selectedPlaceId={null} onSelectPlace={() => {}}
      />,
    )
    const card = container.querySelector<HTMLElement>(`[data-place-id="${noCover!.place_id}"]`)!
    expect(card.querySelector('img')).toBeNull()
    expect(card.querySelector('[data-cover="none"]')).not.toBeNull()
  })

  /* The workspace does not pass a bundle yet. Without one the panel cannot know a cover exists,
     and must degrade to the same honest placeholder rather than throwing or drawing nothing. */
  it('degrades to placeholders when no bundle is supplied', () => {
    const { container } = render(
      <ItineraryCards places={day1} trailNumbers={PINS} selectedPlaceId={null} onSelectPlace={() => {}} />,
    )
    expect(container.querySelectorAll('img')).toHaveLength(0)
    expect(container.querySelectorAll('[data-cover="none"]')).toHaveLength(day1.length)
  })
})

/* ── Estimated times ──────────────────────────────────────────────────────────────────────
   There is NO clock time and NO dwell duration anywhere in the schema — `TripPlace` has no
   duration field, and the only `place_durations` in the codebase is HOTEL-hub → place ROUTE
   duration (selectors.ts::hubSpokeFeatures), which is a travel time, not time-at-place. So a
   start/end pair can only ever be DERIVED, and only from durations we actually hold. When we
   hold none, the panel prints none: a fabricated schedule is exactly the hallucinated-claim
   failure the evidence chip beside it exists to rule out. */
describe('ItineraryCards estimated times', () => {
  const clock = /^\d{1,2}:\d{2}$/

  it('prints no times at all when no dwell durations are supplied', () => {
    render(
      <ItineraryCards
        places={day1} legs={day1Legs} placeIndex={idx} trailNumbers={PINS}
        selectedPlaceId={null} onSelectPlace={() => {}}
      />,
    )
    expect(screen.queryAllByText(clock)).toHaveLength(0)
    expect(screen.queryByText(/est\./i)).toBeNull()
  })

  /* Derived from the REAL numbers, not from even spacing: 09:00 start, +60 min at Akasaka,
     + leg_1's 150 s (the same "3 min" the folded leg prints), +30 min at the cafe. */
  it('derives times from the real dwell and travel durations, and labels them estimates', () => {
    const dwell = new Map([[day1[0].place_id, 3600], [day1[1].place_id, 1800]])
    render(
      <ItineraryCards
        places={day1} legs={day1Legs} placeIndex={idx} trailNumbers={PINS} dwellSeconds={dwell}
        selectedPlaceId={null} onSelectPlace={() => {}}
      />,
    )
    const steps = screen.getAllByRole('listitem')
    expect(within(steps[0]).getByText('09:00')).toBeInTheDocument()
    expect(within(steps[0]).getByText('10:00')).toBeInTheDocument()
    expect(within(steps[1]).getByText('10:03')).toBeInTheDocument()   // 10:00 + leg_1's 3 min
    expect(within(steps[1]).getByText('10:33')).toBeInTheDocument()
    // Unmissably an estimate, not a booking.
    expect(screen.getAllByText(/est\./i).length).toBeGreaterThan(0)
  })

  /* We know when you ARRIVE somewhere we have no dwell for; we do not know when you leave. */
  it('gives a stop with unknown dwell an arrival but no departure', () => {
    const dwell = new Map([[day1[0].place_id, 3600]])
    render(
      <ItineraryCards
        places={day1} legs={day1Legs} placeIndex={idx} trailNumbers={PINS} dwellSeconds={dwell}
        selectedPlaceId={null} onSelectPlace={() => {}}
      />,
    )
    const steps = screen.getAllByRole('listitem')
    expect(within(steps[1]).getByText('10:03')).toBeInTheDocument()
    expect(within(steps[1]).queryAllByText(clock)).toHaveLength(1)   // arrival only
  })

  /* An empty map is not "a day that starts at 09:00" — it is a day we know nothing about. The
     only number a 09:00 start would print is the assumption itself. */
  it('treats an empty dwell map as no data at all, not as a 09:00 start', () => {
    render(
      <ItineraryCards
        places={day1} legs={day1Legs} placeIndex={idx} trailNumbers={PINS}
        dwellSeconds={new Map()} selectedPlaceId={null} onSelectPlace={() => {}}
      />,
    )
    expect(screen.queryAllByText(clock)).toHaveLength(0)
    expect(screen.queryByText(/est\./i)).toBeNull()
  })

  /* Most saved trips carry no legs. Travel time between two stops is then unknown, so the
     arrival at the second stop is unknowable — and is left blank rather than guessed at. */
  it('stops estimating past a gap in the travel data', () => {
    const dwell = new Map([[day1[0].place_id, 3600], [day1[1].place_id, 1800]])
    render(
      <ItineraryCards
        places={day1} legs={[]} placeIndex={idx} trailNumbers={PINS} dwellSeconds={dwell}
        selectedPlaceId={null} onSelectPlace={() => {}}
      />,
    )
    const steps = screen.getAllByRole('listitem')
    expect(within(steps[0]).getByText('09:00')).toBeInTheDocument()
    expect(within(steps[1]).queryAllByText(clock)).toHaveLength(0)
  })
})
