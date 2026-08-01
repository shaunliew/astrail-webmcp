import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    <a href={typeof href === 'string' ? href : ''} {...props}>{children}</a>,
}))

const { listTrips } = vi.hoisted(() => ({ listTrips: vi.fn() }))
vi.mock('@/lib/trip/supabase-api', () => ({ listTrips }))
// The map pane is desktop-only and jsdom has no matchMedia, so it never mounts here — but
// mock it anyway so a change to that gating can't drag the shared-map context into this test.
vi.mock('@/components/trips/TripMapDashboard', () => ({ default: () => null }))

import TripsList from '@/components/trips/TripsList'

describe('TripsList', () => {
  beforeEach(() => { listTrips.mockReset() })

  it('selects nothing until a row is clicked (you land on the idle globe first)', async () => {
    listTrips.mockResolvedValueOnce([TOKYO_TRIP.trip])
    render(<TripsList />)

    // Selecting is in-place (a button), navigating is a distinct link — no nested interactives.
    const row = await screen.findByRole('button', { name: /tokyo/i })
    expect(row).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('link', { name: /open .*tokyo.* trip/i })).toBeNull()

    await userEvent.click(row)

    expect(row).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('link', { name: /open .*tokyo.* trip/i }))
      .toHaveAttribute('href', `/app/trip/${TOKYO_TRIP.trip.id}`)
  })

  it('moves selection (and the Open link) when another row is clicked', async () => {
    const second = { ...TOKYO_TRIP.trip, id: 'trip-2', inferred_destination: 'Osaka' }
    listTrips.mockResolvedValueOnce([TOKYO_TRIP.trip, second])
    render(<TripsList />)

    const firstRow = await screen.findByRole('button', { name: /tokyo/i })
    await userEvent.click(firstRow)
    expect(firstRow).toHaveAttribute('aria-pressed', 'true')

    const secondRow = screen.getByRole('button', { name: /osaka/i })
    await userEvent.click(secondRow)

    expect(secondRow).toHaveAttribute('aria-pressed', 'true')
    expect(firstRow).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('link', { name: /open .*osaka.* trip/i }))
      .toHaveAttribute('href', '/app/trip/trip-2')
  })

  it('shows a composed, illustrated empty state when there are no trips', async () => {
    listTrips.mockResolvedValueOnce([])
    const { container } = render(<TripsList />)
    const copy = await screen.findByText('No trails yet. Your saved trips will land here.')
    expect(screen.getByRole('link', { name: /plan your first trip/i })).toHaveAttribute('href', '/app')
    // Composed per DESIGN.md: centered and illustrated, with a decorative mascot.
    expect(copy.closest('div')).toHaveClass('items-center', 'text-center')
    const mascot = container.querySelector('[data-mascot="astronaut"]')
    expect(mascot).not.toBeNull()
    expect(mascot).toHaveAttribute('aria-hidden', 'true')
    expect(mascot).not.toHaveClass('astronaut-trail--waiting')
  })
})
