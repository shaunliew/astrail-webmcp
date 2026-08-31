import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import HotelPanel from '@/components/trip/HotelPanel'
import { tripHotels } from '@/lib/trip/selectors'
import { TOKYO_TRIP_WITH_HOTELS } from '@/lib/trip/fixtures/tokyo-hotels'
import type { HotelSuggestion } from '@/lib/trip/backend-types'

/* The hotels moved out of `TOKYO_TRIP` when the public sample trail stopped shipping a
   fabricated Travala price (see tokyo-hotels.ts). The panel still has to render them: trips
   generated before hotel search was switched off still have real rows in the database, and
   hiding a user's own data would be its own dishonesty. */
const HOTELS = tripHotels(TOKYO_TRIP_WITH_HOTELS)
const placed = HOTELS.find((h) => h.geo_status === 'placed')!        // hotel_1: placed + recommended (rank 1)
const unresolved = HOTELS.find((h) => h.geo_status === 'unresolved')! // hotel_2: skipped → never placed

function renderPanel(
  hotels: HotelSuggestion[],
  opts: {
    selectedHotelId?: string | null
    onSelectHotel?: (id: string) => void
    layerMode?: 'route' | 'hub'
  } = {},
) {
  return render(
    <HotelPanel
      hotels={hotels}
      selectedHotelId={opts.selectedHotelId ?? null}
      onSelectHotel={opts.onSelectHotel ?? (() => {})}
      layerMode={opts.layerMode ?? 'route'}
    />,
  )
}

describe('HotelPanel', () => {
  it('renders each hotel name', () => {
    renderPanel(HOTELS)
    expect(screen.getByText(placed.name)).toBeInTheDocument()
  })

  it('shows a skipped state for a skipped hotel', () => {
    const skipped = HOTELS.find((h) => h.status === 'skipped')!
    renderPanel([skipped])
    expect(screen.getByText(/skipped/i)).toBeInTheDocument()
  })

  it('renders the composed empty state when there are no hotels', () => {
    renderPanel([])
    expect(screen.getByText(/no hotel suggestions for these dates/i)).toBeInTheDocument()
  })

  it('renders a recommended badge on the rank-1 hotel', () => {
    renderPanel([placed])
    expect(screen.getByText(/recommended/i)).toBeInTheDocument()
  })

  // Pre-beta fix (2026-08-06): price_snapshot has been persisted since day one but was never
  // rendered — the meta line now leads with it.
  it('shows the per-night price from the snapshot', () => {
    renderPanel([placed]) // fixture: { pricePerNight: 128, totalPrice: 384, currency: 'USD' }
    expect(screen.getByText(/128 USD\/night/)).toBeInTheDocument()
  })

  it('falls back to the stay total when only totalPrice is present', () => {
    const totalOnly: HotelSuggestion = {
      ...placed, id: 'hotel_totalonly',
      price_snapshot: { totalPrice: 384, currency: 'USD' },
    }
    renderPanel([totalOnly])
    expect(screen.getByText(/384 USD total/)).toBeInTheDocument()
  })

  it('renders no price when the snapshot is empty', () => {
    renderPanel([unresolved]) // fixture hotel_2: price_snapshot {}
    expect(screen.queryByText(/night|total/i)).not.toBeInTheDocument()
  })

  // Zero is missing, not free: a 0 price must render nothing, never "0 USD/night" (review nit).
  it('treats a zero price as missing rather than rendering a free hotel', () => {
    const zeroPrice: HotelSuggestion = {
      ...placed, id: 'hotel_zeroprice',
      price_snapshot: { pricePerNight: 0, totalPrice: 0, currency: 'USD' },
    }
    renderPanel([zeroPrice])
    expect(screen.queryByText(/night|total/i)).not.toBeInTheDocument()
  })

  // Defensive-read guard: a snapshot whose price is a STRING (or any non-finite value) must render
  // no price — never a coerced or NaN figure. Pins the typeof gate in priceLabel.
  it('rejects a non-numeric price value instead of coercing it', () => {
    const stringPrice: HotelSuggestion = {
      ...placed, id: 'hotel_strprice',
      price_snapshot: { pricePerNight: '128', currency: 'USD' },
    }
    renderPanel([stringPrice])
    expect(screen.queryByText(/\/night/)).not.toBeInTheDocument()
  })

  it('selecting a placed hotel calls onSelectHotel with its id', () => {
    const onSelectHotel = vi.fn()
    renderPanel([placed], { onSelectHotel })
    // The placed hotel is the sole interactive row (a hub-pick button).
    fireEvent.click(screen.getByRole('button'))
    expect(onSelectHotel).toHaveBeenCalledWith(placed.id)
  })

  it('shows the honest note for an unresolved hotel and makes it non-selectable', () => {
    const onSelectHotel = vi.fn()
    renderPanel([unresolved], { onSelectHotel })
    expect(screen.getByText(/couldn.t place this hotel on the map/i)).toBeInTheDocument()
    // Guardrail #1: an unplaceable hotel has no pin, so it is never a selectable hub button.
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('gates on geo_status not status: a search-succeeded but geocode-failed hotel is non-selectable', () => {
    // The exact Guardrail #1 case (decision #7): Travala search SUCCEEDED (status 'suggested')
    // but the geocode failed, so geo_status is 'unresolved' with no coords. The panel must gate on
    // geo_status, NOT status — pins this against a regression that swaps the gate to `status`.
    const geocodeFailed: HotelSuggestion = {
      ...placed, id: 'hotel_geofail', status: 'suggested', geo_status: 'unresolved',
      lat: null, lng: null, route_score: null, rank: null, is_recommended: false,
      place_durations: {},
    }
    const onSelectHotel = vi.fn()
    renderPanel([geocodeFailed], { onSelectHotel })
    expect(screen.getByText(/couldn.t place this hotel on the map/i)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('makes a placed top-3 hotel (rank set) a selectable hub button', () => {
    // The shortlist is placed + ranked (rank ∈ {1,2,3}). A rank-2 placed hotel is a hub candidate.
    const rank2: HotelSuggestion = { ...placed, id: 'hotel_rank2', rank: 2, is_recommended: false }
    const onSelectHotel = vi.fn()
    renderPanel([rank2], { onSelectHotel })
    fireEvent.click(screen.getByRole('button'))
    expect(onSelectHotel).toHaveBeenCalledWith('hotel_rank2')
  })

  it('renders a placed-but-unranked hotel (top-3 overflow) plainly: not a button, no honest note', () => {
    // geo_status='placed' with rank===null is a 4th+ placed hotel: it DID geocode, it just is not a
    // top-3 hub candidate. It shows plainly (name + meta), never as a hub-pick button, and never the
    // "couldn't place" note — that note is honest only for hotels that actually failed to geocode.
    const rankNull: HotelSuggestion = {
      ...placed, id: 'hotel_overflow', rank: null, is_recommended: false,
    }
    renderPanel([rankNull])
    expect(screen.getByText(rankNull.name)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByText(/couldn.t place this hotel on the map/i)).not.toBeInTheDocument()
  })

  it('does not offer a hub the map cannot draw: a placed hotel with null coords is non-selectable', () => {
    // Defense-in-depth (Codex P2): geo_status='placed' + rank set but lat/lng null must NOT be a
    // selectable hub — the map has no point to pin. Guards against a partially-written row.
    const noCoords: HotelSuggestion = { ...placed, id: 'hotel_nocoords', lat: null, lng: null }
    renderPanel([noCoords])
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('marks the selected hub as on the map only in hub mode', () => {
    const { rerender } = renderPanel([placed], { selectedHotelId: placed.id, layerMode: 'route' })
    // In route mode the selection is latent (the route line is drawn, not the hub).
    expect(screen.queryByText(/on map/i)).not.toBeInTheDocument()
    rerender(
      <HotelPanel hotels={[placed]} selectedHotelId={placed.id} onSelectHotel={() => {}} layerMode="hub" />,
    )
    expect(screen.getByText(/on map/i)).toBeInTheDocument()
  })

  /* The hover affordance here was dead for the same reason the itinerary's selected border was:
     `hover:border-[var(--brass)]` is a layered single-class utility and the scoped `.surface`
     rules in globals.css are UNLAYERED, so they win outright and the border never paints. The
     selected half was already fixed by `.surface--selected`; the hover half was missed on the
     first sweep and survived because nothing asserted it — jsdom resolves no cascade, so a
     button can request a style, render the class, pass every test and paint nothing.

     Both sides are pinned, as in ItineraryCards: the markup must ask for the modifier AND
     globals.css must still define it. A class assertion alone goes green against a stylesheet
     that dropped the rule. */
  it('paints hover with a modifier the stylesheet actually defines', async () => {
    const { readFileSync } = await import('node:fs')
    expect(readFileSync('app/globals.css', 'utf8')).toMatch(/\.surface--hoverable:hover/)

    // Only a PLACED hotel renders as a button, so the fixture gives one — both branches are
    // covered by rendering it each way rather than by needing two rows.
    const view = renderPanel([placed, unresolved], { selectedHotelId: null })
    const idle = screen.getByRole('button')
    expect(idle.className).toContain('surface--hoverable')
    expect(idle.className).not.toContain('hover:border-[var(--brass)]')

    view.rerender(
      <HotelPanel hotels={[placed, unresolved]} selectedHotelId={placed.id} onSelectHotel={() => {}} layerMode="route" />,
    )
    const chosen = screen.getByRole('button')
    expect(chosen.className).toContain('surface--selected')
    expect(chosen.className).not.toContain('surface--hoverable')
  })
})
