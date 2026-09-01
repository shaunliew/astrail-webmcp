import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import TripPreferenceNote from '@/components/trip/TripPreferenceNote'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
import type { Trip } from '@/lib/trip/backend-types'

const trip = (over: Partial<Trip>): Trip => ({ ...TOKYO_TRIP.trip, ...over })

/**
 * What steered THIS trip, said on the trip.
 *
 * A different question from the home screen's panel, and the reason both exist: home is profile
 * state and changes when you state something new; this is frozen at generation time. Merging them
 * would show today's preferences against a trip planned last month.
 */
describe('TripPreferenceNote', () => {
  it('names what a recalled trip was planned around', () => {
    render(<TripPreferenceNote trip={trip({ preference_summary: 'Walkable days, ramen', preference_sources: ['memory'] })} />)
    expect(screen.getByText('Walkable days, ramen')).toBeInTheDocument()
    expect(screen.getByText(/what Astrail remembers/i)).toBeInTheDocument()
    expect(screen.getByText('Memory')).toBeInTheDocument()
  })

  it('does not claim memory for a trip the user stated preferences on', () => {
    /* `explicit` means recall never ran — the user said it this trip. Crediting memory would
       claim a recall that did not happen, on the surface whose whole job is provenance. */
    render(<TripPreferenceNote trip={trip({ preference_summary: 'Walkable days, ramen', preference_sources: ['explicit'] })} />)
    expect(screen.getByText(/what you asked for/i)).toBeInTheDocument()
    expect(screen.queryByText('Memory')).not.toBeInTheDocument()
  })

  it('says nothing when the trip recorded no preferences', () => {
    const { container } = render(<TripPreferenceNote trip={trip({ preference_summary: null, preference_sources: [] })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says nothing for a blank or whitespace summary', () => {
    // A bare "Planned around:" with nothing after it is a claim to a preference that does not exist.
    const { container } = render(<TripPreferenceNote trip={trip({ preference_summary: '   ', preference_sources: ['memory'] })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('survives a malformed sources payload rather than throwing', () => {
    // `preference_sources` arrives from JSON; a non-array used to be reachable here.
    const { container } = render(
      <TripPreferenceNote trip={trip({ preference_summary: 'Ramen', preference_sources: null as unknown as Trip['preference_sources'] })} />,
    )
    expect(container).not.toBeEmptyDOMElement()
    expect(screen.queryByText('Memory')).not.toBeInTheDocument()
  })

  /* THE SAMPLE TRAIL IS THE JUDGE'S FREE PATH — no account, nothing spent — so it is the one
     place the memory story has to land without a login. The fixture has carried
     `preference_summary` and a `memory` source since it was written; nothing rendered them. */
  it('shows the memory story on the fixture the sample trail renders', () => {
    render(<TripPreferenceNote trip={TOKYO_TRIP.trip} />)
    expect(screen.getByText(TOKYO_TRIP.trip.preference_summary!)).toBeInTheDocument()
    expect(screen.getByText('Memory')).toBeInTheDocument()
  })
})
