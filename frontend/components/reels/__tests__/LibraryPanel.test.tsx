import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// The card-fan carousel drives its layout with gsap inside a useEffect. jsdom has no real
// layout/RAF, so no-op gsap keeps the fan from flaking and leaves its card buttons
// synchronously clickable for the browse-tap assertion.
vi.mock('gsap', () => ({
  default: { to: vi.fn(), set: vi.fn(), killTweensOf: vi.fn() },
}))

import LibraryPanel from '@/components/reels/LibraryPanel'
import type { SavedReelCard, SavedReelPlaceProof } from '@/lib/reels/backend-types'

function place(over: Partial<SavedReelPlaceProof>): SavedReelPlaceProof {
  return {
    place_id: 'p1', name: 'Place', lat: 0, lng: 0, country_code: 'JP', country_name: 'Japan',
    evidence_quote: 'q', source_url: null, source_reel_url: 'https://ig/reel/x', confidence: 1, ...over,
  }
}

function card(over: Partial<SavedReelCard>): SavedReelCard {
  return {
    id: 'r1', user_id: 'u1', normalized_url: 'https://ig/reel/r1', source_platform: 'instagram',
    reel_cache_id: null, analysis_status: 'not_analyzed', personal_label: null, retry_after: null,
    analyzed_at: null, created_at: '2026-07-18T00:00:00Z', updated_at: '2026-07-18T00:00:00Z',
    caption: null, thumbnail_url: null, has_current_cache: false, places: [], ...over,
  }
}

const noop = async () => {}
const toSelect = () => fireEvent.click(screen.getByRole('button', { name: /^select$/i }))

describe('LibraryPanel', () => {
  afterEach(() => { cleanup() })

  it('narrows the list to a chosen country filter chip', () => {
    const jp = card({ id: 'jp', caption: 'Tokyo Tower', places: [place({ country_code: 'JP', country_name: 'Japan', name: 'Tokyo Tower' })] })
    const kr = card({ id: 'kr', caption: 'Myeongdong', places: [place({ country_code: 'KR', country_name: 'South Korea', name: 'Myeongdong' })] })

    render(<LibraryPanel cards={[jp, kr]} onClose={vi.fn()} onOpenReel={vi.fn()} onOrganize={noop} />)
    toSelect()

    expect(screen.getByText('Tokyo Tower')).toBeInTheDocument()
    expect(screen.getByText('Myeongdong')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Japan' }))

    expect(screen.getByText('Tokyo Tower')).toBeInTheDocument()
    expect(screen.queryByText('Myeongdong')).not.toBeInTheDocument()
  })

  it('narrows the list by search across caption, personal_label and place names', () => {
    const a = card({ id: 'a', caption: 'Sunset above the bay', places: [place({ name: 'Tokyo Tower' })] })
    const b = card({ id: 'b', caption: null, personal_label: 'Kyoto trip', places: [place({ name: 'Fushimi Inari' })] })

    render(<LibraryPanel cards={[a, b]} onClose={vi.fn()} onOpenReel={vi.fn()} onOrganize={noop} />)
    toSelect()

    const search = screen.getByLabelText(/search/i)

    fireEvent.change(search, { target: { value: 'sunset' } }) // caption
    expect(screen.getByText('Sunset above the bay')).toBeInTheDocument()
    expect(screen.queryByText('Kyoto trip')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'inari' } }) // place name
    expect(screen.getByText('Kyoto trip')).toBeInTheDocument()
    expect(screen.queryByText('Sunset above the bay')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'KYOTO' } }) // personal_label, case-insensitive
    expect(screen.getByText('Kyoto trip')).toBeInTheDocument()
    expect(screen.queryByText('Sunset above the bay')).not.toBeInTheDocument()
  })

  it('fires onOpenReel with the matching card when a fan card is tapped in browse mode', () => {
    const onOpenReel = vi.fn()
    const target = card({ id: 'r7', caption: 'Osaka nights', thumbnail_url: 'https://img.test/osaka.jpg' })

    render(<LibraryPanel cards={[target]} onClose={vi.fn()} onOpenReel={onOpenReel} onOrganize={noop} />)

    // Browse is the default mode; the fan renders the reel as a button named by its alt.
    fireEvent.click(screen.getByRole('button', { name: /osaka nights/i }))

    expect(onOpenReel).toHaveBeenCalledTimes(1)
    expect(onOpenReel).toHaveBeenCalledWith(target)
  })

  it('organizes selected reels through onOrganize and caps the selection at five', async () => {
    const onOrganize = vi.fn(async () => {})
    const cards = Array.from({ length: 6 }, (_, i) => card({ id: `r${i}`, caption: `Reel ${i}` }))

    render(<LibraryPanel cards={cards} onClose={vi.fn()} onOpenReel={vi.fn()} onOrganize={onOrganize} />)
    toSelect()

    for (let i = 0; i < 6; i++) {
      fireEvent.click(screen.getByRole('button', { name: `Select Reel ${i}` }))
    }

    // The sixth pick is blocked at the cap of five.
    expect(screen.getByText('5 / 5 selected')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^plan a trip$/i }))

    await waitFor(() => expect(onOrganize).toHaveBeenCalledWith(['r0', 'r1', 'r2', 'r3', 'r4']))
  })

  it('shows a place count for an analyzed card and a status for an unanalyzed one', () => {
    const analyzed = card({ id: 'a', caption: 'Has places', places: [place({ place_id: 'p1' }), place({ place_id: 'p2' })] })
    const raw = card({ id: 'b', caption: 'Fresh save', analysis_status: 'not_analyzed', places: [] })

    render(<LibraryPanel cards={[analyzed, raw]} onClose={vi.fn()} onOpenReel={vi.fn()} onOrganize={noop} />)
    toSelect()

    expect(screen.getByText('Places found · 2')).toBeInTheDocument()
    expect(screen.getByText('Not analyzed')).toBeInTheDocument()
  })

  it('returns to the trays home via the back control', () => {
    const onClose = vi.fn()
    render(<LibraryPanel cards={[]} onClose={onClose} onOpenReel={vi.fn()} onOrganize={noop} />)

    fireEvent.click(screen.getByRole('button', { name: /back/i }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
