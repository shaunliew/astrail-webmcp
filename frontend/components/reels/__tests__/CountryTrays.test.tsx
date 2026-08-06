import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

// CountryTrays paints a full-bleed VerifiedPlacesMap (mapbox-gl) behind its sheet; stub it
// so this stays a focused unit test of the selection sheet + the new Back seam, not the map.
vi.mock('@/components/reels/VerifiedPlacesMap', () => ({ default: () => <div data-testid="places-map" /> }))

import CountryTrays from '@/components/reels/CountryTrays'
import type { CountryTray } from '@/lib/reels/organize'
import type { SavedReelPlaceProof } from '@/lib/reels/backend-types'

function place(over: Partial<SavedReelPlaceProof>): SavedReelPlaceProof {
  return {
    place_id: 'p1', name: 'Place', lat: 0, lng: 0, country_code: 'JP', country_name: 'Japan',
    evidence_quote: 'q', source_url: null, source_reel_url: 'https://ig/reel/x', confidence: 1, ...over,
  }
}

const trays: CountryTray[] = [
  { country_code: 'JP', country_name: 'Japan', places: [place({ place_id: 'p1', name: 'Tokyo Tower' })] },
]

describe('CountryTrays', () => {
  afterEach(() => cleanup())

  it('renders a Back control that fires onBack (additive create-trail escape, T3.1b)', () => {
    const onBack = vi.fn()
    render(<CountryTrays trays={trays} selectedPlaceIds={[]} maxSelected={5} onToggle={vi.fn()} onPlan={vi.fn()} onBack={onBack} />)

    fireEvent.click(screen.getByRole('button', { name: /back/i }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('omits the Back control when onBack is not provided (the prop is purely additive)', () => {
    render(<CountryTrays trays={trays} selectedPlaceIds={[]} maxSelected={5} onToggle={vi.fn()} onPlan={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument()
  })

  it('labels a reel place "Source Reel" and a /p/ post place "Source post" (URL-kind)', () => {
    const mixed: CountryTray[] = [
      {
        country_code: 'JP', country_name: 'Japan',
        places: [
          place({ place_id: 'p1', name: 'Reel place', source_reel_url: 'https://www.instagram.com/reel/R1/' }),
          place({ place_id: 'p2', name: 'Post place', source_reel_url: 'https://www.instagram.com/p/POST1/' }),
        ],
      },
    ]
    render(<CountryTrays trays={mixed} selectedPlaceIds={[]} maxSelected={5} onToggle={vi.fn()} onPlan={vi.fn()} />)

    expect(screen.getByRole('link', { name: /source reel/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /source post/i })).toBeInTheDocument()
  })

  // Regression: on desktop the collapsed sheet slides fully off-screen (grip included), so a
  // dedicated reopen tab must exist and round-trip the collapse — otherwise collapsing is a
  // dead end with no way back.
  it('offers a reopen control that re-expands the collapsed sheet', () => {
    render(<CountryTrays trays={trays} selectedPlaceIds={[]} maxSelected={5} onToggle={vi.fn()} onPlan={vi.fn()} />)

    // Open state: the grip collapses.
    expect(screen.getByRole('button', { name: /hide places/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /hide places/i }))

    // Collapsed: the edge reopen tab re-expands, and the grip reads "Show places" again.
    fireEvent.click(screen.getByTestId('reopen-places'))
    expect(screen.getByRole('button', { name: /hide places/i })).toBeInTheDocument()
  })
})
