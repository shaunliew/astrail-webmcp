import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import HotelPanel from '@/components/trip/HotelPanel'
import { tripHotels } from '@/lib/trip/selectors'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
import type { HotelSuggestion } from '@/lib/trip/backend-types'

const HOTELS = tripHotels(TOKYO_TRIP)
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
})
