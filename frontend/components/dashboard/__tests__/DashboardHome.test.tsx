import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { getUser, listTrips } = vi.hoisted(() => ({
  getUser: vi.fn(async () => ({ data: { user: { email: 'zh@astrail.app', user_metadata: {} } } })),
  listTrips: vi.fn(async () => []),
}))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: { getUser } }) }))
vi.mock('@/lib/trip/supabase-api', () => ({ listTrips }))

import DashboardHome from '@/components/dashboard/DashboardHome'
import type { SavedReelCard, SavedReelPlaceProof } from '@/lib/reels/backend-types'

function place(name: string): SavedReelPlaceProof {
  return {
    place_id: name, name, lat: 0, lng: 0, country_code: 'JP', country_name: 'Japan',
    evidence_quote: name, source_url: null, source_reel_url: 'https://ig/reel/x', confidence: 0.9,
  }
}

function card(over: Partial<SavedReelCard>): SavedReelCard {
  return {
    id: 'r1', user_id: 'u1', normalized_url: 'https://ig/reel/r1', source_platform: 'instagram',
    reel_cache_id: null, analysis_status: 'not_analyzed', personal_label: null, retry_after: null,
    analyzed_at: null, created_at: '2026-07-18T00:00:00Z', updated_at: '2026-07-18T00:00:00Z',
    caption: null, thumbnail_url: null, has_current_cache: false, places: [],
    ...over,
  }
}

const noop = async () => {}

describe('DashboardHome', () => {
  beforeEach(() => {
    getUser.mockClear()
    listTrips.mockReset()
    listTrips.mockResolvedValue([])
  })

  it('shows each Reel with a status label derived from analysis_status', async () => {
    const cards = [
      card({ id: 'a', personal_label: 'Ramen in Shibuya', analysis_status: 'organized', places: [place('X'), place('Y')] }),
      card({ id: 'b', caption: 'Sunrise temple', analysis_status: 'not_analyzed' }),
    ]
    render(<DashboardHome cards={cards} onCapture={noop} onOrganize={noop} />)
    expect(await screen.findByText('Ramen in Shibuya')).toBeInTheDocument()
    expect(screen.getByText('Places found · 2')).toBeInTheDocument()
    expect(screen.getByText('Sunrise temple')).toBeInTheDocument()
    expect(screen.getByText('Not analyzed')).toBeInTheDocument()
  })

  it('filters the Reel strip by analysis_status chips', async () => {
    const cards = [
      card({ id: 'a', personal_label: 'Found one', analysis_status: 'organized', places: [place('X')] }),
      card({ id: 'b', personal_label: 'Pending one', analysis_status: 'processing' }),
    ]
    render(<DashboardHome cards={cards} onCapture={noop} onOrganize={noop} />)
    await screen.findByText('Found one')
    fireEvent.click(screen.getByRole('button', { name: /^Processing/ }))
    expect(screen.queryByText('Found one')).not.toBeInTheDocument()
    expect(screen.getByText('Pending one')).toBeInTheDocument()
  })

  it('shows the empty state when there are no Reels and no trips', async () => {
    render(<DashboardHome cards={[]} onCapture={noop} onOrganize={noop} />)
    expect(await screen.findByText(/no trails yet/i)).toBeInTheDocument()
  })

  it('selects Reels and plans a trip from them', async () => {
    const onOrganize = vi.fn(async () => {})
    const cards = [card({ id: 'a', personal_label: 'Pick me', analysis_status: 'organized', places: [place('X')] })]
    render(<DashboardHome cards={cards} onCapture={noop} onOrganize={onOrganize} />)
    await screen.findByText('Pick me')
    fireEvent.click(screen.getByRole('button', { name: /plan a trip from these/i }))
    fireEvent.click(screen.getByRole('button', { name: /Pick me/i }))
    fireEvent.click(screen.getByRole('button', { name: /^plan a trip$/i }))
    await waitFor(() => expect(onOrganize).toHaveBeenCalledWith(['a']))
  })
})
