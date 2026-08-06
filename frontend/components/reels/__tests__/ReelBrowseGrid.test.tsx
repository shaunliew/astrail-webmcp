import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import ReelBrowseGrid from '@/components/reels/ReelBrowseGrid'
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

describe('ReelBrowseGrid', () => {
  afterEach(() => { cleanup() })

  it('renders a labelled button per card that scans place-count and country', () => {
    const bali = card({
      id: 'bali',
      caption: 'Bali café hop',
      places: [
        place({ place_id: 'p1', country_code: 'ID', country_name: 'Indonesia', name: 'Kuta' }),
        place({ place_id: 'p2', country_code: 'ID', country_name: 'Indonesia', name: 'Ubud' }),
      ],
    })

    render(<ReelBrowseGrid cards={[bali]} onOpenReel={vi.fn()} />)

    // The card is a button named by reelLabel, and its meta line reads count + country.
    expect(screen.getByRole('button', { name: 'Bali café hop' })).toBeInTheDocument()
    expect(screen.getByText('Places found · 2 · Indonesia')).toBeInTheDocument()
  })

  it('shows the analysis status for a place-less reel and a country hint spanning countries', () => {
    const fresh = card({ id: 'a', personal_label: 'Fresh save', analysis_status: 'not_analyzed', places: [] })
    const multi = card({
      id: 'multi',
      caption: 'Tokyo to Seoul',
      places: [
        place({ place_id: 'p1', country_code: 'JP', country_name: 'Japan' }),
        place({ place_id: 'p2', country_code: 'KR', country_name: 'South Korea' }),
      ],
    })

    render(<ReelBrowseGrid cards={[fresh, multi]} onOpenReel={vi.fn()} />)

    // No places → status label, no country suffix.
    expect(screen.getByText('Not analyzed')).toBeInTheDocument()
    // Multiple distinct countries collapse to a compact "+N" hint.
    expect(screen.getByText('Places found · 2 · Japan +1')).toBeInTheDocument()
  })

  it('fires onOpenReel with the tapped card', () => {
    const onOpenReel = vi.fn()
    const target = card({ id: 'r7', caption: 'Osaka nights', thumbnail_url: 'https://img.test/osaka.jpg' })

    render(<ReelBrowseGrid cards={[target]} onOpenReel={onOpenReel} />)

    fireEvent.click(screen.getByRole('button', { name: 'Osaka nights' }))

    expect(onOpenReel).toHaveBeenCalledTimes(1)
    expect(onOpenReel).toHaveBeenCalledWith(target)
  })

  it('caps the accessible name to the first sentence for a long caption', () => {
    const longCaption =
      'Chicken nanban is my favorite comfort food and this spot nails it. A second sentence that must not reach the name.'
    const c = card({ id: 'long', personal_label: null, caption: longCaption })

    render(<ReelBrowseGrid cards={[c]} onOpenReel={vi.fn()} />)

    // Only the first sentence is exposed; the rest of the caption is dropped from the name.
    expect(
      screen.getByRole('button', { name: 'Chicken nanban is my favorite comfort food and this spot nails it' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /second sentence/i })).not.toBeInTheDocument()
  })

  it('badges a reel card Reel and a /p/ post card Post (URL-kind badge)', () => {
    const reel = card({ id: 'r', caption: 'Reel one', normalized_url: 'https://www.instagram.com/reel/R1/' })
    const post = card({ id: 'p', caption: 'Post one', normalized_url: 'https://www.instagram.com/p/POST1/' })

    render(<ReelBrowseGrid cards={[reel, post]} onOpenReel={vi.fn()} />)

    expect(screen.getByText('Reel')).toBeInTheDocument()
    expect(screen.getByText('Post')).toBeInTheDocument()
  })

  it('falls back to "Untitled reel" when a card has neither a label nor a caption', () => {
    const bare = card({ id: 'bare', personal_label: null, caption: null })

    render(<ReelBrowseGrid cards={[bare]} onOpenReel={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Untitled reel' })).toBeInTheDocument()
  })
})
