import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    <a href={typeof href === 'string' ? href : ''} {...props}>{children}</a>,
}))

import TripCard from '@/components/trips/TripCard'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

describe('TripCard', () => {
  it('links to the trip view and shows its title and status', () => {
    render(<TripCard trip={TOKYO_TRIP.trip} />)
    expect(screen.getByRole('link')).toHaveAttribute('href', `/app/trip/${TOKYO_TRIP.trip.id}`)
    expect(screen.getByRole('heading', { name: /tokyo/i })).toBeInTheDocument()
    expect(screen.getByText(/saved with gaps/i)).toBeInTheDocument()
  })
})
