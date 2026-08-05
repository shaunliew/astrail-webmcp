import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import TradeoffPanel from '@/components/trip/TradeoffPanel'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

describe('TradeoffPanel', () => {
  it('renders nothing when both tradeoff axes are empty', () => {
    const { container } = render(<TradeoffPanel tradeoffs={{ notes: [], comparisons: [] }} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders deterministic notes', () => {
    const note = TOKYO_TRIP.trip.tradeoffs.notes[0]
    render(<TradeoffPanel tradeoffs={{ notes: [note], comparisons: [] }} />)
    expect(screen.getByText(note.detail)).toBeInTheDocument()
  })

  it('renders hotel comparisons with Astrail attribution', () => {
    const comparison = TOKYO_TRIP.trip.tradeoffs.comparisons[0]
    render(<TradeoffPanel tradeoffs={{ notes: [], comparisons: [comparison] }} />)
    expect(screen.getByRole('heading', { name: 'Price vs rating' })).toBeInTheDocument()
    expect(screen.getByText(comparison.option_a.label)).toBeInTheDocument()
    expect(screen.getByText(comparison.option_b.label)).toBeInTheDocument()
    expect(screen.getByText('Astrail')).toBeInTheDocument()
  })

  // Merge-lite variants (2026-08-06): notes render at the top of the trip panel, comparisons
  // render inside "Where to stay" — each variant must show ONLY its half.
  it('notes variant renders pacing notes under "Heads up" and no comparison cards', () => {
    const t = TOKYO_TRIP.trip.tradeoffs
    render(<TradeoffPanel tradeoffs={t} variant="notes" />)
    expect(screen.getByRole('heading', { name: 'Heads up' })).toBeInTheDocument()
    expect(screen.getByText(t.notes[0].detail)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Price vs rating' })).not.toBeInTheDocument()
  })

  it('comparisons variant renders the card with no outer heading and no notes', () => {
    const t = TOKYO_TRIP.trip.tradeoffs
    render(<TradeoffPanel tradeoffs={t} variant="comparisons" />)
    expect(screen.getByRole('heading', { name: 'Price vs rating' })).toBeInTheDocument()
    // No outer heading: the surrounding Section already titles the surface.
    expect(screen.queryByRole('heading', { name: /tradeoffs|heads up/i })).not.toBeInTheDocument()
    expect(screen.queryByText(t.notes[0].detail)).not.toBeInTheDocument()
  })

  // Load-bearing null-guard: the empty check must run on the VARIANT-FILTERED lists. A comparisons
  // variant with only notes present must render nothing at all — not an empty section shell.
  it('a variant with nothing to show renders nothing', () => {
    const { container } = render(
      <TradeoffPanel
        tradeoffs={{ notes: [TOKYO_TRIP.trip.tradeoffs.notes[0]], comparisons: [] }}
        variant="comparisons"
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
