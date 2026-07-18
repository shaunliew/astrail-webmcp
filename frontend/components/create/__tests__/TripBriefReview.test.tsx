import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { buildReelItems, makeRequestedPlace, type BriefInput, type DraftInspirationItem } from '@/lib/trip/parse-inspiration'

const { getProfile } = vi.hoisted(() => ({ getProfile: vi.fn() }))

vi.mock('@/lib/auth/mock-auth', () => ({ MOCK_AUTH_ENABLED: true }))
vi.mock('@/lib/trip/mock-api', () => ({ getProfile }))

import TripBriefReview from '@/components/create/TripBriefReview'

const BRIEF: BriefInput = {
  destination_hint: 'Tokyo, Japan',
  start_date: '2026-08-01',
  end_date: '2026-08-04',
  origin_city: 'Singapore',
  budget_level: '',
  preferences: '',
}

const REEL = buildReelItems('https://www.instagram.com/reel/AAA/', []).items[0]

function renderReview(items: DraftInspirationItem[] = [REEL]) {
  return render(<TripBriefReview items={items} brief={BRIEF} onBack={vi.fn()} onGenerate={vi.fn()} />)
}

describe('TripBriefReview', () => {
  beforeEach(() => {
    getProfile.mockReset()
    getProfile.mockRejectedValue(new Error('mock profile unavailable'))
  })

  it('renders reels, places, dates, duration, and the default budget', () => {
    renderReview([...buildReelItems('https://www.instagram.com/reel/AAA/', []).items, makeRequestedPlace('Tokyo Disneyland', [])!])
    expect(screen.getByText('https://www.instagram.com/reel/AAA/')).toBeInTheDocument()
    expect(screen.getByText('Tokyo Disneyland')).toBeInTheDocument()
    expect(screen.getByText('2026-08-01 to 2026-08-04')).toBeInTheDocument()
    expect(screen.getByText('3 nights / 4 days')).toBeInTheDocument()
    expect(screen.getByText('Mid-range (default)')).toBeInTheDocument()
    expect(screen.getByText('Singapore')).toBeInTheDocument()
  })

  it('shows the scope warning at nine items but not at eight', () => {
    const fiveReels = buildReelItems(
      Array.from({ length: 5 }, (_, n) => `https://www.instagram.com/reel/R${n}/`).join('\n'), [],
    ).items
    const nineItems = [...fiveReels, ...['A', 'B', 'C', 'D'].map((place) => makeRequestedPlace(place, [])!)]
    const eightItems = [...fiveReels, ...['A', 'B', 'C'].map((place) => makeRequestedPlace(place, [])!)]

    const { unmount } = renderReview(nineItems)
    expect(screen.getByRole('alert')).toHaveTextContent("That's more than fits an itinerary")
    unmount()

    renderReview(eightItems)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('returns to compose through Back', () => {
    const onBack = vi.fn()
    render(<TripBriefReview items={[REEL]} brief={BRIEF} onBack={onBack} onGenerate={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('renders explicit, memory, and inferred-default disclosures', async () => {
    const explicit = render(<TripBriefReview items={[REEL]} brief={{ ...BRIEF, preferences: 'ramen and walkable days' }} onBack={vi.fn()} onGenerate={vi.fn()} />)
    expect(screen.getByText('Explicit')).toBeInTheDocument()
    expect(screen.getByText('ramen and walkable days')).toBeInTheDocument()
    explicit.unmount()

    getProfile.mockResolvedValueOnce({ profile: {}, facts: [{ status: 'active', fact_key: 'likes_cuisine', fact_value: 'ramen', category: 'food' }] })
    renderReview()
    expect(await screen.findByText('Using your saved travel preferences')).toBeInTheDocument()
    expect(screen.getByText('likes ramen')).toBeInTheDocument()

    getProfile.mockRejectedValueOnce(new Error('mock profile unavailable'))
    renderReview()
    expect(screen.getAllByText('Inferred default')).toHaveLength(1)
    expect(screen.getAllByText(/Astrail will infer your trip style/)).toHaveLength(1)
  })
})
