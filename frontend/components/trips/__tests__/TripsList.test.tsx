import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    <a href={typeof href === 'string' ? href : ''} {...props}>{children}</a>,
}))

const { listTrips } = vi.hoisted(() => ({ listTrips: vi.fn() }))
vi.mock('@/lib/trip/supabase-api', () => ({ listTrips }))
vi.mock('@/components/auth/SignOutButton', () => ({ default: () => <button type="button">Sign out</button> }))

import TripsList from '@/components/trips/TripsList'

describe('TripsList', () => {
  beforeEach(() => { listTrips.mockReset() })

  it('renders a card linking to the trip once loaded', async () => {
    listTrips.mockResolvedValueOnce([TOKYO_TRIP.trip])
    render(<TripsList />)
    expect(await screen.findByRole('link', { name: /tokyo/i })).toHaveAttribute('href', `/app/trip/${TOKYO_TRIP.trip.id}`)
  })

  it('shows an empty state when there are no trips', async () => {
    listTrips.mockResolvedValueOnce([])
    render(<TripsList />)
    expect(await screen.findByText('No trails yet. Your saved trips will land here.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /plan your first trip/i })).toHaveAttribute('href', '/app')
  })
})
