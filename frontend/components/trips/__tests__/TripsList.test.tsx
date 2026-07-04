import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    <a href={typeof href === 'string' ? href : ''} {...props}>{children}</a>,
}))

const { listTrips } = vi.hoisted(() => ({ listTrips: vi.fn() }))
vi.mock('@/lib/trip/mock-api', () => ({ listTrips }))

import TripsList from '@/components/trips/TripsList'

describe('TripsList', () => {
  beforeEach(() => { listTrips.mockReset() })

  it('renders a card linking to the trip once loaded', async () => {
    listTrips.mockResolvedValueOnce([TOKYO_TRIP.trip])
    render(<TripsList />)
    expect(await screen.findByRole('heading', { name: /tokyo/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /tokyo/i })).toHaveAttribute('href', `/app/trip/${TOKYO_TRIP.trip.id}`)
  })

  it('shows an empty state when there are no trips', async () => {
    listTrips.mockResolvedValueOnce([])
    render(<TripsList />)
    expect(await screen.findByText(/no trips yet/i)).toBeInTheDocument()
  })
})
