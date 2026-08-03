import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    <a href={typeof href === 'string' ? href : ''} {...props}>{children}</a>,
}))

import TrialExhaustedCard from '@/components/entitlement/TrialExhaustedCard'

const HEADLINE = 'Your free trip is planned.'
const BODY = "Beta seats unlock unlimited planning — we're self-funded, so only 25 exist."

describe('TrialExhaustedCard', () => {
  it('shows the exact copy and a "Request a seat" button in the not-yet-requested state', () => {
    render(
      <TrialExhaustedCard
        seatRequested={false}
        onRequestSeat={vi.fn()}
        canonicalTripId={null}
        canonicalTripLoading={false}
      />,
    )
    expect(screen.getByText(HEADLINE)).toBeInTheDocument()
    expect(screen.getByText(BODY)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Request a seat' })).toBeInTheDocument()
  })

  it('calls onRequestSeat when the button is clicked', () => {
    const onRequestSeat = vi.fn()
    render(
      <TrialExhaustedCard
        seatRequested={false}
        onRequestSeat={onRequestSeat}
        canonicalTripId={null}
        canonicalTripLoading={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Request a seat' }))
    expect(onRequestSeat).toHaveBeenCalledTimes(1)
  })

  it('renders the confirmation and NO button once the seat is requested', () => {
    render(
      <TrialExhaustedCard
        seatRequested
        onRequestSeat={vi.fn()}
        canonicalTripId={null}
        canonicalTripLoading={false}
      />,
    )
    expect(screen.queryByRole('button', { name: /request a seat/i })).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(/seat requested/i)
  })

  it('shows the "Open your trip" link with the right href when the trip id is resolved', () => {
    render(
      <TrialExhaustedCard
        seatRequested={false}
        onRequestSeat={vi.fn()}
        canonicalTripId="trip-9"
        canonicalTripLoading={false}
      />,
    )
    expect(screen.getByRole('link', { name: 'Open your trip' })).toHaveAttribute(
      'href',
      '/app/trip/trip-9',
    )
  })

  it('hides the trip link while the canonical trip is still loading', () => {
    render(
      <TrialExhaustedCard
        seatRequested={false}
        onRequestSeat={vi.fn()}
        canonicalTripId="trip-9"
        canonicalTripLoading
      />,
    )
    expect(screen.queryByRole('link', { name: /open your trip/i })).toBeNull()
  })

  it('hides the trip link when no trip id resolves', () => {
    render(
      <TrialExhaustedCard
        seatRequested={false}
        onRequestSeat={vi.fn()}
        canonicalTripId={null}
        canonicalTripLoading={false}
      />,
    )
    expect(screen.queryByRole('link', { name: /open your trip/i })).toBeNull()
  })
})
