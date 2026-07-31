import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const { getUser, listCollections, getMembershipsByCollection } = vi.hoisted(() => ({
  getUser: vi.fn(async () => ({ data: { user: { email: 'zh@astrail.app', user_metadata: { full_name: 'Zhi Hao' } } } })),
  listCollections: vi.fn(),
  getMembershipsByCollection: vi.fn(),
}))

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: { getUser } }) }))
vi.mock('@/lib/reels/collections', () => ({ listCollections, getMembershipsByCollection }))
// Opening the Library swaps in LibraryPanel, whose card-fan drives gsap in a useEffect;
// no-op it so the fan cannot flake in jsdom during this integration test.
vi.mock('gsap', () => ({ default: { to: vi.fn(), set: vi.fn(), killTweensOf: vi.fn() } }))

import TraysScreen from '@/components/reels/TraysScreen'
import type { ReelCollection, SavedReelCard } from '@/lib/reels/backend-types'

function collection(over: Partial<ReelCollection>): ReelCollection {
  return {
    id: 'c1', user_id: 'u1', name: 'Tray', sort_order: 0,
    created_at: '2026-07-18T00:00:00Z', updated_at: '2026-07-18T00:00:00Z', ...over,
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

describe('TraysScreen', () => {
  beforeEach(() => {
    getUser.mockClear()
    listCollections.mockReset(); listCollections.mockResolvedValue([])
    getMembershipsByCollection.mockReset(); getMembershipsByCollection.mockResolvedValue({})
  })
  afterEach(() => { cleanup() })

  it('renders one tray per collection with its reel count from memberships', async () => {
    listCollections.mockResolvedValue([
      collection({ id: 'c1', name: 'Tokyo winter' }),
      collection({ id: 'c2', name: 'Korea Myeongdong' }),
    ])
    getMembershipsByCollection.mockResolvedValue({ c1: ['r1', 'r2'], c2: ['r1'] })
    const cards = [card({ id: 'r1', caption: 'Tokyo Tower' }), card({ id: 'r2', caption: 'Shibuya' })]

    render(<TraysScreen cards={cards} onCapture={noop} onOrganize={noop} />)

    expect(await screen.findByRole('button', { name: 'Tokyo winter' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Korea Myeongdong' })).toBeInTheDocument()
    expect(screen.getByText('2 reels')).toBeInTheDocument()
    expect(screen.getByText('1 reel')).toBeInTheDocument()
  })

  it('renders an empty tray (zero memberships) with an Open control and a zero count', async () => {
    listCollections.mockResolvedValue([collection({ id: 'c2', name: 'Empty tray' })])
    getMembershipsByCollection.mockResolvedValue({})

    render(<TraysScreen cards={[]} onCapture={noop} onOrganize={noop} />)

    expect(await screen.findByRole('button', { name: 'Empty tray' })).toBeInTheDocument()
    expect(screen.getByText('0 reels')).toBeInTheDocument()
  })

  it('shows the create tile and the Library banner', async () => {
    listCollections.mockResolvedValue([collection({ id: 'c1', name: 'Tokyo winter' })])

    render(<TraysScreen cards={[]} onCapture={noop} onOrganize={noop} />)

    expect(await screen.findByRole('button', { name: 'Tokyo winter' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /create a tray/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /your inspiration starts here/i })).toBeInTheDocument()
  })

  it('opens the Library panel from the banner as a full-surface swap and returns home on back', async () => {
    const cards = [card({ id: 'r1', caption: 'Tokyo Tower at sunset' })]

    render(<TraysScreen cards={cards} onCapture={noop} onOrganize={noop} />)

    fireEvent.click(await screen.findByRole('button', { name: /your inspiration starts here/i }))

    // LibraryPanel replaces the home content — its header shows and the greeting is gone.
    expect(screen.getByText(/your saved reels live here/i)).toBeInTheDocument()
    expect(screen.queryByText(/welcome back/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /back/i }))

    expect(await screen.findByRole('button', { name: /your inspiration starts here/i })).toBeInTheDocument()
  })

  it('captures a Reel URL through onCapture', async () => {
    const onCapture = vi.fn(async () => {})

    render(<TraysScreen cards={[]} onCapture={onCapture} onOrganize={noop} />)

    fireEvent.change(screen.getByLabelText(/paste a reel link/i), {
      target: { value: 'https://www.instagram.com/reel/AAA/' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(onCapture).toHaveBeenCalledWith('https://www.instagram.com/reel/AAA/'))
  })

  it('shows the empty state when there are no reels and no trays', async () => {
    render(<TraysScreen cards={[]} onCapture={noop} onOrganize={noop} />)

    expect(await screen.findByText(/no trails yet/i)).toBeInTheDocument()
  })

  it('keeps capture working and surfaces a soft error when the trays fetch fails', async () => {
    listCollections.mockRejectedValue(new Error('network down'))
    const onCapture = vi.fn(async () => {})

    render(<TraysScreen cards={[card({ id: 'r1', caption: 'Kyoto' })]} onCapture={onCapture} onOrganize={noop} />)

    expect(await screen.findByText(/could not load your trays/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/paste a reel link/i), { target: { value: 'https://ig/reel/z' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(onCapture).toHaveBeenCalledWith('https://ig/reel/z'))
  })
})
